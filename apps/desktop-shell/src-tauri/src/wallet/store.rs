// On-disk storage envelope for the embedded Agentic Wallet.
//
// Persists `desktop-wallet.json` next to the existing `desktop-secure.json`
// in `desktop_config_dir()`. The 64-byte BIP-39 seed is encrypted with
// AES-256-GCM under a KEK that's password-derived (Argon2id) AND wrapped by
// the OS keychain device key.
//
// The schema is versioned so future KEK/cipher changes can migrate without
// blowing away existing wallets. The address is cached in plaintext so
// `wallet_status` can report it without requiring an unlock.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use zeroize::Zeroizing;

use crate::wallet::crypto::{decrypt, derive_kek, encrypt, random_salt, DEVICE_KEY_LEN, NONCE_LEN, SALT_LEN};

/// Current envelope schema version.
pub const ENVELOPE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m_kib: 65_536,
            t: 3,
            p: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletFile {
    pub version: u32,
    pub kdf: String,
    pub kdf_params: KdfParams,
    /// Base64-encoded salt for KEK derivation.
    pub salt: String,
    /// Base64-encoded AES-GCM nonce.
    pub nonce: String,
    /// Base64-encoded AES-256-GCM ciphertext over the 64-byte BIP-39 seed.
    pub ciphertext: String,
    /// Public address (base58 ed25519 public key). Safe to show without unlock.
    pub address: String,
    /// Persisted so future migrations can re-derive deterministically.
    pub derivation_path: String,
    /// RFC 3339 timestamp.
    pub created_at: String,
}

impl WalletFile {
    /// Build a `WalletFile` by encrypting `plaintext` (typically the BIP-39
    /// mnemonic as UTF-8 bytes) under a KEK derived from `password` +
    /// `device_key`.
    pub fn create(
        password: &str,
        plaintext: &[u8],
        address: &str,
        derivation_path: &str,
        device_key: &[u8; DEVICE_KEY_LEN],
    ) -> Result<Self, String> {
        if password.is_empty() {
            return Err("password must not be empty".into());
        }
        let salt = random_salt();
        let kek = derive_kek(password.as_bytes(), device_key, &salt)?;
        let kek = Zeroizing::new(kek);
        let (nonce, ciphertext) = encrypt(&kek, plaintext)?;

        Ok(Self {
            version: ENVELOPE_VERSION,
            kdf: "argon2id".into(),
            kdf_params: KdfParams::default(),
            salt: B64.encode(salt),
            nonce: B64.encode(nonce),
            ciphertext: B64.encode(ciphertext),
            address: address.to_string(),
            derivation_path: derivation_path.to_string(),
            created_at: rfc3339_now(),
        })
    }

    /// Decrypt the envelope back to plaintext bytes (typically the mnemonic).
    /// Returns `Err("invalid password")` on any auth failure.
    pub fn decrypt(
        &self,
        password: &str,
        device_key: &[u8; DEVICE_KEY_LEN],
    ) -> Result<Zeroizing<Vec<u8>>, String> {
        if self.version != ENVELOPE_VERSION {
            return Err(format!("unsupported wallet version {}", self.version));
        }
        if self.kdf != "argon2id" {
            return Err(format!("unsupported kdf {}", self.kdf));
        }
        let salt = B64
            .decode(&self.salt)
            .map_err(|err| format!("salt decode: {err}"))?;
        if salt.len() != SALT_LEN {
            return Err(format!(
                "salt length mismatch: expected {} got {}",
                SALT_LEN,
                salt.len()
            ));
        }
        let nonce_bytes = B64
            .decode(&self.nonce)
            .map_err(|err| format!("nonce decode: {err}"))?;
        if nonce_bytes.len() != NONCE_LEN {
            return Err(format!(
                "nonce length mismatch: expected {} got {}",
                NONCE_LEN,
                nonce_bytes.len()
            ));
        }
        let mut nonce_arr = [0u8; NONCE_LEN];
        nonce_arr.copy_from_slice(&nonce_bytes);
        let ciphertext = B64
            .decode(&self.ciphertext)
            .map_err(|err| format!("ciphertext decode: {err}"))?;

        let kek = derive_kek(password.as_bytes(), device_key, &salt)?;
        let kek = Zeroizing::new(kek);
        let plaintext = decrypt(&kek, &nonce_arr, &ciphertext)?;
        Ok(Zeroizing::new(plaintext))
    }

    /// Re-encrypt the same plaintext under a new password (used by
    /// `wallet_change_password`).
    pub fn rewrap(
        &self,
        old_password: &str,
        new_password: &str,
        device_key: &[u8; DEVICE_KEY_LEN],
    ) -> Result<Self, String> {
        if new_password.is_empty() {
            return Err("new password must not be empty".into());
        }
        let plaintext = self.decrypt(old_password, device_key)?;
        WalletFile::create(
            new_password,
            &plaintext,
            &self.address,
            &self.derivation_path,
            device_key,
        )
    }
}

fn rfc3339_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Minimal RFC 3339 formatting without pulling in chrono.
    let (year, month, day, hour, minute, second) = unix_to_components(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

/// Convert a Unix timestamp to (Y, M, D, h, m, s) in UTC. Handles dates from
/// 1970-01-01 onward. Pulled in here to avoid a chrono dependency for one
/// formatted timestamp.
fn unix_to_components(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let second = (secs % 60) as u32;
    let total_min = secs / 60;
    let minute = (total_min % 60) as u32;
    let total_hr = total_min / 60;
    let hour = (total_hr % 24) as u32;
    let mut days = total_hr / 24;
    let mut year = 1970i32;
    loop {
        let y_days = days_in_year(year);
        if days < y_days as u64 {
            break;
        }
        days -= y_days as u64;
        year += 1;
    }
    let mut month = 1u32;
    loop {
        let m_days = days_in_month(year, month) as u64;
        if days < m_days {
            break;
        }
        days -= m_days;
        month += 1;
    }
    let day = days as u32 + 1;
    (year, month, day, hour, minute, second)
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_year(year: i32) -> u32 {
    if is_leap(year) {
        366
    } else {
        365
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Load a wallet file from disk. `Ok(None)` when the file doesn't exist.
pub fn load(path: &Path) -> Result<Option<WalletFile>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("read {}: {err}", path.display()))?;
    let file = serde_json::from_str::<WalletFile>(&raw)
        .map_err(|err| format!("parse {}: {err}", path.display()))?;
    Ok(Some(file))
}

/// Atomically save a wallet file with 0600 perms on Unix.
///
/// Writes to a sibling `.tmp` file, sets 0600 perms on the temp, then renames
/// into place. A `TempFileGuard` removes the temp on any error path — without
/// it, a failed `rename` would leak encrypted-envelope JSON to disk forever.
pub fn save(file: &WalletFile, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create dir {}: {err}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(file)
        .map_err(|err| format!("encode wallet: {err}"))?;

    let tmp = temp_sibling(path);
    let mut guard = TempFileGuard::new(tmp.clone());
    fs::write(&tmp, raw).map_err(|err| format!("write {}: {err}", tmp.display()))?;
    // Set 0600 on the temp BEFORE rename — Unix rename preserves the inode
    // (and therefore its perms), so the destination starts with the
    // restrictive mode atomically. Surfacing an error here keeps us from
    // ever shipping a 0644 wallet file.
    set_private_perms(&tmp)?;
    fs::rename(&tmp, path)
        .map_err(|err| format!("rename {} -> {}: {err}", tmp.display(), path.display()))?;
    // Rename succeeded: ownership transfers to the destination path, so the
    // guard no longer needs to clean up the (now-gone) temp.
    guard.commit();
    Ok(())
}

/// RAII guard that deletes a temp file when dropped, unless `commit()` has
/// been called. Lets the atomic-save path bail at any step without leaving
/// encrypted-envelope JSON on disk.
struct TempFileGuard {
    path: Option<std::path::PathBuf>,
}

impl TempFileGuard {
    fn new(path: std::path::PathBuf) -> Self {
        Self { path: Some(path) }
    }
    fn commit(&mut self) {
        self.path = None;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

/// Delete the wallet file if it exists. Idempotent.
pub fn delete(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("delete {}: {err}", path.display())),
    }
}

fn temp_sibling(path: &Path) -> std::path::PathBuf {
    let file_name = path
        .file_name()
        .and_then(|os| os.to_str())
        .unwrap_or("desktop-wallet.json");
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    path.with_file_name(format!("{file_name}.{}.{}.tmp", std::process::id(), millis))
}

fn set_private_perms(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::metadata(path)
            .map_err(|err| format!("perms stat {}: {err}", path.display()))?;
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)
            .map_err(|err| format!("perms set {}: {err}", path.display()))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // Windows ACL hardening is tracked separately; non-Unix is a no-op
        // for now so the cross-platform build doesn't bail.
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const SAMPLE_MNEMONIC: &[u8] = b"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    fn fixture() -> (TempDir, [u8; DEVICE_KEY_LEN]) {
        let dir = TempDir::new().unwrap();
        let device_key = [3u8; DEVICE_KEY_LEN];
        (dir, device_key)
    }

    #[test]
    fn create_then_decrypt_round_trip() {
        let (_dir, device_key) = fixture();
        let file = WalletFile::create(
            "hunter2",
            SAMPLE_MNEMONIC,
            "TestAddress11111111111111111111111111111111",
            "m/44'/501'/0'/0'",
            &device_key,
        )
        .unwrap();
        let decrypted = file.decrypt("hunter2", &device_key).unwrap();
        assert_eq!(decrypted.as_slice(), SAMPLE_MNEMONIC);
    }

    #[test]
    fn wrong_password_returns_clean_error() {
        let (_dir, device_key) = fixture();
        let file = WalletFile::create("hunter2", SAMPLE_MNEMONIC, "Addr", "m/44'/501'/0'/0'", &device_key)
            .unwrap();
        let err = file.decrypt("wrong", &device_key).unwrap_err();
        assert_eq!(err, "invalid password");
    }

    #[test]
    fn wrong_device_key_returns_invalid_password() {
        let (_dir, device_key_a) = fixture();
        let device_key_b = [4u8; DEVICE_KEY_LEN];
        let file = WalletFile::create("hunter2", SAMPLE_MNEMONIC, "Addr", "m/44'/501'/0'/0'", &device_key_a)
            .unwrap();
        let err = file.decrypt("hunter2", &device_key_b).unwrap_err();
        assert_eq!(err, "invalid password");
    }

    #[test]
    fn save_load_round_trip_preserves_envelope() {
        let (dir, device_key) = fixture();
        let file = WalletFile::create("p", SAMPLE_MNEMONIC, "Addr", "m/44'/501'/0'/0'", &device_key).unwrap();
        let path = dir.path().join("desktop-wallet.json");
        save(&file, &path).unwrap();
        let loaded = load(&path).unwrap().unwrap();
        assert_eq!(loaded.address, file.address);
        assert_eq!(loaded.derivation_path, file.derivation_path);
        let decrypted = loaded.decrypt("p", &device_key).unwrap();
        assert_eq!(decrypted.as_slice(), SAMPLE_MNEMONIC);
    }

    #[test]
    fn load_missing_file_returns_none() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("not-there.json");
        let loaded = load(&path).unwrap();
        assert!(loaded.is_none());
    }

    #[test]
    fn rewrap_changes_password_but_keeps_address() {
        let (_dir, device_key) = fixture();
        let file =
            WalletFile::create("old", SAMPLE_MNEMONIC, "Addr", "m/44'/501'/0'/0'", &device_key).unwrap();
        let rewrapped = file.rewrap("old", "new", &device_key).unwrap();
        assert_eq!(rewrapped.address, file.address);
        assert!(file.decrypt("new", &device_key).is_err());
        let decrypted = rewrapped.decrypt("new", &device_key).unwrap();
        assert_eq!(decrypted.as_slice(), SAMPLE_MNEMONIC);
    }

    #[test]
    fn delete_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("desktop-wallet.json");
        delete(&path).unwrap();
        fs::write(&path, "anything").unwrap();
        delete(&path).unwrap();
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn save_sets_0600_perms() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, device_key) = fixture();
        let file = WalletFile::create("p", SAMPLE_MNEMONIC, "Addr", "m/44'/501'/0'/0'", &device_key).unwrap();
        let path = dir.path().join("desktop-wallet.json");
        save(&file, &path).unwrap();
        let perms = fs::metadata(&path).unwrap().permissions();
        assert_eq!(perms.mode() & 0o777, 0o600);
    }

    #[test]
    fn unix_to_components_known_epochs() {
        assert_eq!(unix_to_components(0), (1970, 1, 1, 0, 0, 0));
        // 2024-01-01 00:00:00 UTC = 1704067200
        assert_eq!(unix_to_components(1_704_067_200), (2024, 1, 1, 0, 0, 0));
    }

    #[test]
    fn save_leaves_no_temp_sibling_on_success() {
        // The atomic-save path uses a `.tmp` sibling and a RAII guard. After
        // a successful save the only file in the dir should be the real one.
        let (dir, device_key) = fixture();
        let file = WalletFile::create(
            "p",
            SAMPLE_MNEMONIC,
            "Addr",
            "m/44'/501'/0'/0'",
            &device_key,
        )
        .unwrap();
        let path = dir.path().join("desktop-wallet.json");
        save(&file, &path).unwrap();
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["desktop-wallet.json".to_string()]);
    }

    #[test]
    fn temp_file_guard_removes_temp_on_drop() {
        // RAII semantics: dropping without commit unlinks the file. This
        // guards against the "fs::rename failed and we leaked encrypted
        // JSON" regression that Slice R hardened against.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("leaks-me.tmp");
        fs::write(&path, b"shouldn't survive").unwrap();
        {
            let _guard = TempFileGuard::new(path.clone());
            // drop without commit
        }
        assert!(!path.exists(), "temp file should have been removed on guard drop");
    }

    #[test]
    fn temp_file_guard_keeps_file_after_commit() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("kept.tmp");
        fs::write(&path, b"should survive").unwrap();
        {
            let mut guard = TempFileGuard::new(path.clone());
            guard.commit();
        }
        assert!(path.exists(), "committed file should not be removed on guard drop");
    }
}
