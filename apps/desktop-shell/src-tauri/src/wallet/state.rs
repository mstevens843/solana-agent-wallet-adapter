// Embedded-wallet state machine. Held in `SharedRuntime` and accessed via the
// Tauri commands in `wallet/mod.rs`.
//
// Responsibilities:
//   - own the wallet file path and the OS-keychain device-key source
//   - hold the in-memory unlocked keypair while the wallet is unlocked
//   - track auto-lock timeout and elapsed time; lock lazily on each call
//   - expose `status / create / import / unlock / lock / change_password /
//     sign_message / sign_transaction / set_auto_lock / export_mnemonic`
//
// "Lazy" auto-lock: instead of a background thread, every command checks the
// elapsed time first. If the unlock timeout has passed, the in-memory
// keypair is zeroized before the command runs. The UI polls `status` often
// enough that this is functionally indistinguishable from a true timer.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::wallet::crypto::DEVICE_KEY_LEN;
use crate::wallet::keychain::DeviceKeySource;
use crate::wallet::signer::{
    derive_keypair, generate_mnemonic, mnemonic_to_seed, parse_mnemonic, LoadedKeypair,
    SOLANA_DERIVATION_PATH_STR,
};
use crate::wallet::store;

/// Auto-lock default — five minutes, matches Backpack's default UX.
pub const DEFAULT_AUTO_LOCK_SECS: u32 = 300;
pub const MIN_AUTO_LOCK_SECS: u32 = 60;
pub const MAX_AUTO_LOCK_SECS: u32 = 86_400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletStatus {
    pub exists: bool,
    pub unlocked: bool,
    pub address: Option<String>,
    pub derivation_path: Option<String>,
    pub created_at: Option<String>,
    pub auto_lock_secs: u32,
    /// Whole seconds since the wallet was unlocked (rounded down). `None`
    /// when locked. Useful for "locking in N s" UI hints.
    pub idle_seconds: Option<u64>,
}

/// Returned from `create` — the only place the mnemonic is exposed to TS.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletCreated {
    pub address: String,
    /// 24-word mnemonic. Show ONCE, never persist on the TS side.
    /// On `import`, this comes back empty (user already has the phrase).
    pub mnemonic: String,
}

struct UnlockedSession {
    keypair: LoadedKeypair,
    last_activity: Instant,
}

pub struct WalletState {
    file_path: PathBuf,
    device_key_source: DeviceKeySource,
    auto_lock_secs: u32,
    unlocked: Option<UnlockedSession>,
}

impl WalletState {
    pub fn new(
        file_path: PathBuf,
        device_key_source: DeviceKeySource,
        auto_lock_secs: u32,
    ) -> Self {
        Self {
            file_path,
            device_key_source,
            auto_lock_secs: clamp_auto_lock(auto_lock_secs),
            unlocked: None,
        }
    }

    fn device_key(&self) -> Result<[u8; DEVICE_KEY_LEN], String> {
        self.device_key_source.load_or_create()
    }

    /// Returns the latest status. Side effect: auto-locks if the unlock
    /// session has expired.
    pub fn status(&mut self) -> Result<WalletStatus, String> {
        self.maybe_auto_lock();
        let file = store::load(&self.file_path)?;
        let (exists, address, derivation_path, created_at) = match &file {
            Some(f) => (
                true,
                Some(f.address.clone()),
                Some(f.derivation_path.clone()),
                Some(f.created_at.clone()),
            ),
            None => (false, None, None, None),
        };
        let unlocked = self.unlocked.is_some();
        let idle_seconds = self
            .unlocked
            .as_ref()
            .map(|s| s.last_activity.elapsed().as_secs());
        Ok(WalletStatus {
            exists,
            unlocked,
            address,
            derivation_path,
            created_at,
            auto_lock_secs: self.auto_lock_secs,
            idle_seconds,
        })
    }

    /// Generate a fresh wallet. Returns the mnemonic ONCE (caller must show
    /// and clear). The wallet is left unlocked after create — the user just
    /// authenticated with the new password.
    pub fn create(&mut self, password: &str) -> Result<WalletCreated, String> {
        if store::load(&self.file_path)?.is_some() {
            return Err("wallet already exists".into());
        }
        let mnemonic = generate_mnemonic()?;
        let mnemonic_string = mnemonic.to_string();
        let seed = mnemonic_to_seed(&mnemonic);
        let keypair = derive_keypair(&seed)?;
        let address = keypair.address.clone();

        let device_key = self.device_key()?;
        let file = store::WalletFile::create(
            password,
            mnemonic_string.as_bytes(),
            &address,
            SOLANA_DERIVATION_PATH_STR,
            &device_key,
        )?;
        store::save(&file, &self.file_path)?;

        self.unlocked = Some(UnlockedSession {
            keypair,
            last_activity: Instant::now(),
        });
        Ok(WalletCreated {
            address,
            mnemonic: mnemonic_string,
        })
    }

    /// Import a user-supplied mnemonic. After import, wallet is unlocked.
    pub fn import(
        &mut self,
        password: &str,
        mnemonic_input: &str,
    ) -> Result<WalletCreated, String> {
        if store::load(&self.file_path)?.is_some() {
            return Err("wallet already exists".into());
        }
        let mnemonic = parse_mnemonic(mnemonic_input)?;
        let mnemonic_string = mnemonic.to_string();
        let seed = mnemonic_to_seed(&mnemonic);
        let keypair = derive_keypair(&seed)?;
        let address = keypair.address.clone();

        let device_key = self.device_key()?;
        let file = store::WalletFile::create(
            password,
            mnemonic_string.as_bytes(),
            &address,
            SOLANA_DERIVATION_PATH_STR,
            &device_key,
        )?;
        store::save(&file, &self.file_path)?;

        self.unlocked = Some(UnlockedSession {
            keypair,
            last_activity: Instant::now(),
        });
        // On import we don't re-emit the mnemonic — caller already has it.
        Ok(WalletCreated {
            address,
            mnemonic: String::new(),
        })
    }

    pub fn unlock(&mut self, password: &str) -> Result<WalletStatus, String> {
        let file = store::load(&self.file_path)?
            .ok_or_else(|| "no wallet to unlock".to_string())?;
        let device_key = self.device_key()?;
        let mnemonic_bytes = file.decrypt(password, &device_key)?;
        let mnemonic_str = std::str::from_utf8(&mnemonic_bytes)
            .map_err(|_| "stored mnemonic is not utf-8".to_string())?;
        let mnemonic = parse_mnemonic(mnemonic_str)?;
        let seed = mnemonic_to_seed(&mnemonic);
        let keypair = derive_keypair(&seed)?;

        self.unlocked = Some(UnlockedSession {
            keypair,
            last_activity: Instant::now(),
        });
        self.status()
    }

    pub fn lock(&mut self) -> Result<WalletStatus, String> {
        self.unlocked = None; // Drop runs zeroize on the signing key
        self.status()
    }

    pub fn change_password(
        &mut self,
        old_password: &str,
        new_password: &str,
    ) -> Result<WalletStatus, String> {
        let file = store::load(&self.file_path)?
            .ok_or_else(|| "no wallet to change password for".to_string())?;
        let device_key = self.device_key()?;
        let rewrapped = file.rewrap(old_password, new_password, &device_key)?;
        store::save(&rewrapped, &self.file_path)?;
        self.status()
    }

    /// Internal: produce an ed25519 signature over raw bytes after the unlocked
    /// + address checks. Used by both the off-chain message path and the
    /// transaction path; the domain-separation guard lives in `sign_message`.
    fn sign_raw(&mut self, address: &str, bytes: &[u8]) -> Result<[u8; 64], String> {
        self.maybe_auto_lock();
        let session = self
            .unlocked
            .as_mut()
            .ok_or_else(|| "wallet is locked".to_string())?;
        if session.keypair.address != address {
            return Err("address does not match the unlocked wallet".into());
        }
        let sig = session.keypair.sign(bytes);
        session.last_activity = Instant::now();
        Ok(sig)
    }

    /// Sign an off-chain (dApp `signMessage`) payload. Refuses bytes that decode
    /// as a Solana transaction message: otherwise a malicious connected dApp could
    /// call the standard signMessage with transaction bytes and obtain a valid,
    /// broadcastable transaction signature behind a benign "sign message" prompt
    /// (message/transaction signature confusion). Transaction signing must go
    /// through `sign_transaction`, which surfaces the decoded transaction for
    /// approval in the overlay.
    pub fn sign_message(
        &mut self,
        address: &str,
        message: &[u8],
    ) -> Result<[u8; 64], String> {
        if looks_like_solana_message(message) {
            return Err(
                "refusing to sign: this message decodes as a Solana transaction. Use the transaction approval flow instead."
                    .into(),
            );
        }
        self.sign_raw(address, message)
    }

    /// Sign a serialized Solana transaction message. The caller stitches the
    /// returned signature into the transaction container. (The off-chain
    /// domain-separation guard intentionally does NOT apply here — this path is
    /// for transactions.)
    pub fn sign_transaction(
        &mut self,
        address: &str,
        message_bytes: &[u8],
    ) -> Result<[u8; 64], String> {
        self.sign_raw(address, message_bytes)
    }

    pub fn set_auto_lock(&mut self, seconds: u32) -> Result<(), String> {
        self.auto_lock_secs = clamp_auto_lock(seconds);
        Ok(())
    }

    /// Export the mnemonic after re-authenticating with the password. Used
    /// for "show my recovery phrase" UI gated behind a fresh password prompt.
    pub fn export_mnemonic(&mut self, password: &str) -> Result<String, String> {
        let file = store::load(&self.file_path)?
            .ok_or_else(|| "no wallet to export".to_string())?;
        let device_key = self.device_key()?;
        let mnemonic_bytes = file.decrypt(password, &device_key)?;
        std::str::from_utf8(&mnemonic_bytes)
            .map(|s| s.to_string())
            .map_err(|_| "stored mnemonic is not utf-8".to_string())
    }

    /// Delete the wallet file. Caller must already have re-authenticated.
    /// Used by the destructive "reset wallet" flow.
    pub fn delete_wallet(&mut self, password: &str) -> Result<(), String> {
        let file = store::load(&self.file_path)?
            .ok_or_else(|| "no wallet to delete".to_string())?;
        let device_key = self.device_key()?;
        // Verify password before deleting.
        let _ = file.decrypt(password, &device_key)?;
        store::delete(&self.file_path)?;
        self.unlocked = None;
        Ok(())
    }

    fn maybe_auto_lock(&mut self) {
        // `Instant` is guaranteed monotonic by the Rust std library — its
        // value cannot go backwards even when the wall clock is adjusted
        // (NTP step, manual user change, leap second). On modern OSes the
        // underlying source is `CLOCK_MONOTONIC` (Linux) / `mach_absolute_time`
        // (macOS) / `QueryPerformanceCounter` (Windows), all of which keep
        // ticking through suspend/resume on every platform we ship to. That
        // means an idle laptop that sleeps for 8 hours wakes up with a
        // correctly-aged `last_activity` and the next watcher tick locks it.
        if let Some(session) = &self.unlocked {
            if self.auto_lock_secs > 0
                && session.last_activity.elapsed()
                    >= Duration::from_secs(self.auto_lock_secs as u64)
            {
                self.unlocked = None;
            }
        }
    }

    /// Test-only: force the last-activity timestamp back to N seconds ago.
    #[cfg(test)]
    pub fn test_set_idle(&mut self, seconds: u64) {
        if let Some(session) = &mut self.unlocked {
            let now = Instant::now();
            session.last_activity = now
                .checked_sub(Duration::from_secs(seconds))
                .unwrap_or(now);
        }
    }
}

fn clamp_auto_lock(seconds: u32) -> u32 {
    if seconds == 0 {
        return 0;
    }
    seconds.clamp(MIN_AUTO_LOCK_SECS, MAX_AUTO_LOCK_SECS)
}

/// True if `bytes` fully decode as a serialized Solana transaction message
/// (legacy or v0). Used to refuse off-chain `signMessage` payloads that are
/// actually transactions. A full structural parse (header → accounts →
/// blockhash → instructions → v0 lookups) that consumes every byte keeps the
/// false-positive rate near zero: normal text / nonce payloads do not parse.
fn looks_like_solana_message(bytes: &[u8]) -> bool {
    parse_solana_message(bytes).is_some()
}

/// Solana shortvec (compact-u16) decoder. Returns the value and advances `off`.
fn read_compact_u16(bytes: &[u8], off: &mut usize) -> Option<usize> {
    let mut value: usize = 0;
    let mut shift: u32 = 0;
    loop {
        let byte = *bytes.get(*off)?;
        *off += 1;
        value |= ((byte & 0x7f) as usize) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift > 21 {
            return None;
        }
    }
    Some(value)
}

fn parse_solana_message(bytes: &[u8]) -> Option<()> {
    let mut off = 0usize;
    let first = *bytes.first()?;
    let is_v0 = first & 0x80 != 0;
    if is_v0 {
        // Only v0 is recognized; any other versioned prefix is not a message we sign.
        if first != 0x80 {
            return None;
        }
        off = 1;
    }
    // Message header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned.
    let num_required_sigs = *bytes.get(off)? as usize;
    off += 1;
    let _num_readonly_signed = *bytes.get(off)? as usize;
    off += 1;
    let _num_readonly_unsigned = *bytes.get(off)? as usize;
    off += 1;
    if num_required_sigs == 0 || num_required_sigs > 64 {
        return None;
    }
    let account_count = read_compact_u16(bytes, &mut off)?;
    if account_count == 0 || account_count < num_required_sigs || account_count > 256 {
        return None;
    }
    off = off.checked_add(account_count.checked_mul(32)?)?; // account pubkeys
    if off > bytes.len() {
        return None;
    }
    off = off.checked_add(32)?; // recent blockhash
    if off > bytes.len() {
        return None;
    }
    let ix_count = read_compact_u16(bytes, &mut off)?;
    if ix_count > 256 {
        return None;
    }
    for _ in 0..ix_count {
        let _program_id_index = *bytes.get(off)?;
        off += 1;
        let accounts_len = read_compact_u16(bytes, &mut off)?;
        off = off.checked_add(accounts_len)?;
        if off > bytes.len() {
            return None;
        }
        let data_len = read_compact_u16(bytes, &mut off)?;
        off = off.checked_add(data_len)?;
        if off > bytes.len() {
            return None;
        }
    }
    if is_v0 {
        let lookups = read_compact_u16(bytes, &mut off)?;
        for _ in 0..lookups {
            off = off.checked_add(32)?; // lookup table account
            if off > bytes.len() {
                return None;
            }
            let writable = read_compact_u16(bytes, &mut off)?;
            off = off.checked_add(writable)?;
            let readonly = read_compact_u16(bytes, &mut off)?;
            off = off.checked_add(readonly)?;
            if off > bytes.len() {
                return None;
            }
        }
    }
    // A genuine serialized message consumes every byte; trailing data => not a message.
    if off == bytes.len() {
        Some(())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_state() -> (TempDir, WalletState) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("desktop-wallet.json");
        let device_key = [11u8; DEVICE_KEY_LEN];
        let state = WalletState::new(
            path,
            DeviceKeySource::InMemory(device_key),
            DEFAULT_AUTO_LOCK_SECS,
        );
        (dir, state)
    }

    #[test]
    fn status_reports_no_wallet_initially() {
        let (_dir, mut state) = make_state();
        let s = state.status().unwrap();
        assert!(!s.exists);
        assert!(!s.unlocked);
        assert!(s.address.is_none());
    }

    #[test]
    fn create_then_lock_then_unlock_preserves_address() {
        let (_dir, mut state) = make_state();
        let created = state.create("password123").unwrap();
        assert!(!created.mnemonic.is_empty());
        assert_eq!(state.status().unwrap().address.as_deref(), Some(created.address.as_str()));

        state.lock().unwrap();
        let status = state.status().unwrap();
        assert!(status.exists);
        assert!(!status.unlocked);

        state.unlock("password123").unwrap();
        let status = state.status().unwrap();
        assert!(status.unlocked);
        assert_eq!(status.address.as_deref(), Some(created.address.as_str()));
    }

    #[test]
    fn unlock_with_wrong_password_fails() {
        let (_dir, mut state) = make_state();
        state.create("right").unwrap();
        state.lock().unwrap();
        let err = state.unlock("wrong").unwrap_err();
        assert_eq!(err, "invalid password");
    }

    #[test]
    fn create_rejects_when_wallet_already_exists() {
        let (_dir, mut state) = make_state();
        state.create("p1").unwrap();
        let err = state.create("p2").unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[test]
    fn import_round_trip_matches_create_address() {
        let (_dir, mut state) = make_state();
        let created = state.create("p").unwrap();
        let phrase = created.mnemonic.clone();
        let address_a = created.address.clone();

        // Wipe and re-import.
        state.delete_wallet("p").unwrap();
        let imported = state.import("newpw", &phrase).unwrap();
        assert_eq!(imported.address, address_a);
        assert!(imported.mnemonic.is_empty(), "import doesn't re-emit phrase");
    }

    #[test]
    fn sign_requires_unlock() {
        let (_dir, mut state) = make_state();
        let created = state.create("p").unwrap();
        state.lock().unwrap();
        let err = state
            .sign_message(&created.address, b"hello")
            .unwrap_err();
        assert!(err.contains("locked"));
    }

    #[test]
    fn sign_rejects_wrong_address() {
        let (_dir, mut state) = make_state();
        let _ = state.create("p").unwrap();
        let err = state
            .sign_message("WrongAddress11111111111111111111111111111111", b"hi")
            .unwrap_err();
        assert!(err.contains("does not match"));
    }

    #[test]
    fn auto_lock_expires_after_timeout() {
        let (_dir, mut state) = make_state();
        state.set_auto_lock(MIN_AUTO_LOCK_SECS).unwrap();
        state.create("p").unwrap();
        assert!(state.status().unwrap().unlocked);

        state.test_set_idle((MIN_AUTO_LOCK_SECS as u64) + 1);
        let status = state.status().unwrap();
        assert!(!status.unlocked, "wallet should auto-lock after idle");
    }

    #[test]
    fn auto_lock_zero_disables_timeout() {
        let (_dir, mut state) = make_state();
        state.set_auto_lock(0).unwrap();
        state.create("p").unwrap();
        state.test_set_idle(MIN_AUTO_LOCK_SECS as u64);
        let status = state.status().unwrap();
        assert!(status.unlocked, "auto_lock=0 disables timeout");
    }

    #[test]
    fn auto_lock_clamped_to_bounds() {
        let (_dir, mut state) = make_state();
        state.set_auto_lock(1).unwrap(); // below min
        assert_eq!(state.auto_lock_secs, MIN_AUTO_LOCK_SECS);
        state.set_auto_lock(1_000_000).unwrap(); // above max
        assert_eq!(state.auto_lock_secs, MAX_AUTO_LOCK_SECS);
        state.set_auto_lock(0).unwrap();
        assert_eq!(state.auto_lock_secs, 0);
    }

    #[test]
    fn change_password_succeeds_with_old_then_decrypts_with_new() {
        let (_dir, mut state) = make_state();
        let created = state.create("old").unwrap();
        state.change_password("old", "new").unwrap();
        state.lock().unwrap();
        assert!(state.unlock("old").is_err());
        let s = state.unlock("new").unwrap();
        assert_eq!(s.address.as_deref(), Some(created.address.as_str()));
    }

    #[test]
    fn export_mnemonic_requires_correct_password() {
        let (_dir, mut state) = make_state();
        let created = state.create("p").unwrap();
        let phrase = state.export_mnemonic("p").unwrap();
        assert_eq!(phrase, created.mnemonic);
        let err = state.export_mnemonic("wrong").unwrap_err();
        assert_eq!(err, "invalid password");
    }

    #[test]
    fn delete_wallet_requires_password() {
        let (_dir, mut state) = make_state();
        state.create("p").unwrap();
        assert!(state.delete_wallet("wrong").is_err());
        state.delete_wallet("p").unwrap();
        assert!(!state.status().unwrap().exists);
    }

    fn minimal_legacy_message() -> Vec<u8> {
        let mut m = vec![1u8, 0, 0]; // header: 1 required sig
        m.push(1); // compact-u16 account count = 1
        m.extend_from_slice(&[7u8; 32]); // 1 account pubkey
        m.extend_from_slice(&[9u8; 32]); // recent blockhash
        m.push(0); // compact-u16 instruction count = 0
        m
    }

    #[test]
    fn detects_serialized_transaction_messages() {
        assert!(looks_like_solana_message(&minimal_legacy_message()));
        let mut v0 = vec![0x80u8];
        v0.extend_from_slice(&minimal_legacy_message());
        v0.push(0); // v0 address-table-lookups count = 0
        assert!(looks_like_solana_message(&v0));
    }

    #[test]
    fn does_not_flag_normal_offchain_messages() {
        assert!(!looks_like_solana_message(b"agentic.com wants you to sign in with your Solana account"));
        assert!(!looks_like_solana_message(&[42u8; 32])); // 32-byte nonce
        assert!(!looks_like_solana_message(b"")); // empty
        // A real message with trailing junk must not be treated as a clean message.
        let mut trailing = minimal_legacy_message();
        trailing.extend_from_slice(b"junk");
        assert!(!looks_like_solana_message(&trailing));
    }

    #[test]
    fn sign_message_rejects_transaction_bytes_but_sign_transaction_allows_them() {
        let (_dir, mut state) = make_state();
        let created = state.create("p").unwrap();
        let address = created.address;
        let tx = minimal_legacy_message();
        let msg_err = state.sign_message(&address, &tx).unwrap_err();
        assert!(msg_err.contains("decodes as a Solana transaction"));
        // The same bytes are signable through the transaction path.
        assert!(state.sign_transaction(&address, &tx).is_ok());
        // And a normal off-chain message still signs.
        assert!(state.sign_message(&address, b"hello agentic").is_ok());
    }
}
