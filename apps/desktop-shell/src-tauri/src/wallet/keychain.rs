// OS-keychain integration for the per-machine device key.
//
// At first launch we generate a random 32-byte device key and stash it in the
// OS-native secret store via the `keyring` crate (macOS Keychain, Windows
// Credential Manager, Linux Secret Service). The device key is XOR-shrouded
// into the Argon2id KEK in `crypto::derive_kek`, so a stolen
// `desktop-wallet.json` file cannot be brute-forced without ALSO stealing this
// keychain entry on the same machine.
//
// Tests need to inject a deterministic device key without touching the real
// OS keychain (CI doesn't have one). The `Source` enum supports both modes.

use keyring::Entry;
use rand::RngCore;
use zeroize::Zeroize;

use crate::wallet::crypto::DEVICE_KEY_LEN;

const KEYCHAIN_SERVICE: &str = "com.agentic.desktop";
const KEYCHAIN_USER: &str = "embedded-wallet-device-key";

/// Where to look for the device key. Tests use `InMemory`; production uses
/// `OsKeychain` to hit the native secret store.
#[derive(Clone)]
#[allow(dead_code)] // `InMemory` is only constructed by tests (under #[cfg(test)] in callers).
pub enum DeviceKeySource {
    OsKeychain,
    InMemory([u8; DEVICE_KEY_LEN]),
}

impl DeviceKeySource {
    /// Returns the production device-key source (OS keychain).
    pub fn os_keychain() -> Self {
        DeviceKeySource::OsKeychain
    }

    /// Get-or-create the device key for this source.
    ///
    /// `OsKeychain`: reads the existing entry; if missing, generates a random
    /// key and writes it. Returns an error if the keychain is unavailable.
    ///
    /// `InMemory`: returns the fixed bytes.
    pub fn load_or_create(&self) -> Result<[u8; DEVICE_KEY_LEN], String> {
        match self {
            DeviceKeySource::OsKeychain => load_or_create_in_keychain(),
            DeviceKeySource::InMemory(bytes) => Ok(*bytes),
        }
    }
}

fn load_or_create_in_keychain() -> Result<[u8; DEVICE_KEY_LEN], String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|err| format!("keychain entry: {err}"))?;

    match entry.get_password() {
        Ok(encoded) => decode_device_key(&encoded),
        Err(keyring::Error::NoEntry) => {
            let key = generate_device_key();
            let encoded = hex::encode(key);
            entry
                .set_password(&encoded)
                .map_err(|err| format!("keychain write: {err}"))?;
            Ok(key)
        }
        Err(err) => Err(format!("keychain read: {err}")),
    }
}

fn generate_device_key() -> [u8; DEVICE_KEY_LEN] {
    let mut bytes = [0u8; DEVICE_KEY_LEN];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
}

fn decode_device_key(encoded: &str) -> Result<[u8; DEVICE_KEY_LEN], String> {
    let mut decoded = hex::decode(encoded.trim())
        .map_err(|err| format!("keychain entry corrupted (hex): {err}"))?;
    if decoded.len() != DEVICE_KEY_LEN {
        decoded.zeroize();
        return Err(format!(
            "keychain device key length mismatch: expected {} got {}",
            DEVICE_KEY_LEN,
            decoded.len()
        ));
    }
    let mut out = [0u8; DEVICE_KEY_LEN];
    out.copy_from_slice(&decoded);
    decoded.zeroize();
    Ok(out)
}

/// Test-only helper: remove the OS keychain device key entry if present.
/// Useful for cleaning up after manual smoke tests; not used in production.
#[allow(dead_code)]
pub fn delete_os_device_key() -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|err| format!("keychain entry: {err}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("keychain delete: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_source_is_deterministic() {
        let bytes = [42u8; DEVICE_KEY_LEN];
        let source = DeviceKeySource::InMemory(bytes);
        let a = source.load_or_create().unwrap();
        let b = source.load_or_create().unwrap();
        assert_eq!(a, b);
        assert_eq!(a, bytes);
    }

    #[test]
    fn decode_device_key_rejects_wrong_length() {
        let short = hex::encode([1u8; 16]);
        let err = decode_device_key(&short).unwrap_err();
        assert!(err.contains("length mismatch"));
    }

    #[test]
    fn decode_device_key_rejects_invalid_hex() {
        let err = decode_device_key("not-hex").unwrap_err();
        assert!(err.contains("corrupted"));
    }

    #[test]
    fn decode_device_key_accepts_valid_hex() {
        let key = [13u8; DEVICE_KEY_LEN];
        let encoded = hex::encode(key);
        let decoded = decode_device_key(&encoded).unwrap();
        assert_eq!(decoded, key);
    }
}
