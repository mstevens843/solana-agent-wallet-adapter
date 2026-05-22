// Argon2id KEK derivation + AES-256-GCM encrypt/decrypt for the embedded
// Agentic Wallet. Used by `store.rs` to wrap the BIP-39 seed at rest.
//
// The KEK is bound to BOTH the user's password AND a per-machine device key
// stored in the OS keychain (see `keychain.rs`). A leaked `desktop-wallet.json`
// file alone cannot be brute-forced — the attacker also needs the device-key
// entry from the same machine's keychain.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use zeroize::Zeroize;

/// KEK length (AES-256 key).
pub const KEK_LEN: usize = 32;
/// Salt length for Argon2id.
pub const SALT_LEN: usize = 32;
/// Nonce length for AES-256-GCM (12 bytes is mandated by the GCM spec).
pub const NONCE_LEN: usize = 12;
/// Length of the OS-keychain device key.
pub const DEVICE_KEY_LEN: usize = 32;

// Argon2id parameters: ~64 MiB, 3 iterations, parallelism 1.
// These match OWASP's "strong" recommendation for password storage as of 2024
// and are well above the 2017 RFC 9106 minimums.
//
// Migration note: the storage envelope already records `kdf_params` per
// record (see `store::WalletFile::kdf_params`), but `derive_kek` below
// currently always uses these constants. A future slice that raises the
// floor (say, 128 MiB / 4 iterations) should:
//   1. Add a `params: KdfParams` argument to `derive_kek`.
//   2. Have `WalletFile::decrypt` pass `self.kdf_params` through.
//   3. Have `WalletFile::create` and `rewrap` stamp the new defaults.
// That way an old wallet that was sealed with 64 MiB / 3 iters keeps
// unsealing under those parameters, but the next `rewrap` (change
// password) re-encrypts it under the new floor.
const ARGON2_MEMORY_KIB: u32 = 65_536;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;

/// Derive a 32-byte KEK from a password, OS-keychain device key, and salt.
///
/// The password and device key are concatenated before being fed to Argon2id.
/// The salt is per-wallet-file and must be stored alongside the ciphertext.
pub fn derive_kek(
    password: &[u8],
    device_key: &[u8; DEVICE_KEY_LEN],
    salt: &[u8],
) -> Result<[u8; KEK_LEN], String> {
    if password.is_empty() {
        return Err("password must not be empty".into());
    }
    if salt.len() < 8 {
        return Err("salt is too short".into());
    }

    let params = Params::new(ARGON2_MEMORY_KIB, ARGON2_ITERATIONS, ARGON2_PARALLELISM, Some(KEK_LEN))
        .map_err(|err| {
            // Param construction failing means we shipped invalid constants
            // — programmer error, not user-actionable.
            eprintln!("[wallet/crypto] argon2 params construction failed: {err}");
            "wallet key derivation misconfigured".to_string()
        })?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut combined = Vec::with_capacity(password.len() + DEVICE_KEY_LEN);
    combined.extend_from_slice(password);
    combined.extend_from_slice(device_key);

    let mut kek = [0u8; KEK_LEN];
    let result = argon2
        .hash_password_into(&combined, salt, &mut kek)
        .map_err(|err| {
            // Argon2 errors typically signal out-of-memory or a wildly bad
            // salt/length combination — neither needs the user to see the
            // internal description. Log the detail server-side and surface
            // a generic message.
            eprintln!("[wallet/crypto] argon2 derivation failed: {err}");
            "wallet key derivation failed".to_string()
        });

    combined.zeroize();
    result?;
    Ok(kek)
}

/// Generate a random salt suitable for `derive_kek`.
pub fn random_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

/// Generate a random nonce suitable for `encrypt`.
fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    nonce
}

/// AES-256-GCM encrypt. Returns `(nonce, ciphertext_with_auth_tag)`.
pub fn encrypt(
    kek: &[u8; KEK_LEN],
    plaintext: &[u8],
) -> Result<([u8; NONCE_LEN], Vec<u8>), String> {
    let cipher = Aes256Gcm::new_from_slice(kek)
        .map_err(|err| format!("aes-gcm key: {err}"))?;
    let nonce_bytes = random_nonce();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|err| format!("aes-gcm encrypt: {err}"))?;
    Ok((nonce_bytes, ciphertext))
}

/// AES-256-GCM decrypt. Returns `Err("invalid password")` on auth-tag failure
/// (the common case for a wrong password) so the IPC layer can return a clean
/// user-facing message without leaking detail.
pub fn decrypt(
    kek: &[u8; KEK_LEN],
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(kek)
        .map_err(|err| format!("aes-gcm key: {err}"))?;
    let nonce = Nonce::from_slice(nonce);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "invalid password".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_then_decrypt_roundtrip() {
        let device_key = [7u8; DEVICE_KEY_LEN];
        let salt = random_salt();
        let kek = derive_kek(b"correct horse battery staple", &device_key, &salt).unwrap();
        let payload = b"some secret bytes";
        let (nonce, ct) = encrypt(&kek, payload).unwrap();
        let pt = decrypt(&kek, &nonce, &ct).unwrap();
        assert_eq!(pt, payload);
    }

    #[test]
    fn wrong_password_decrypt_returns_invalid_password() {
        let device_key = [9u8; DEVICE_KEY_LEN];
        let salt = random_salt();
        let kek_right = derive_kek(b"hunter2", &device_key, &salt).unwrap();
        let kek_wrong = derive_kek(b"hunter3", &device_key, &salt).unwrap();
        let (nonce, ct) = encrypt(&kek_right, b"top secret").unwrap();
        let err = decrypt(&kek_wrong, &nonce, &ct).unwrap_err();
        assert_eq!(err, "invalid password");
    }

    #[test]
    fn wrong_device_key_decrypt_fails() {
        let device_key_a = [1u8; DEVICE_KEY_LEN];
        let device_key_b = [2u8; DEVICE_KEY_LEN];
        let salt = random_salt();
        let kek_a = derive_kek(b"same password", &device_key_a, &salt).unwrap();
        let kek_b = derive_kek(b"same password", &device_key_b, &salt).unwrap();
        assert_ne!(kek_a, kek_b, "different device keys must produce different KEKs");
        let (nonce, ct) = encrypt(&kek_a, b"payload").unwrap();
        let err = decrypt(&kek_b, &nonce, &ct).unwrap_err();
        assert_eq!(err, "invalid password");
    }

    #[test]
    fn empty_password_rejected() {
        let device_key = [0u8; DEVICE_KEY_LEN];
        let salt = random_salt();
        let err = derive_kek(b"", &device_key, &salt).unwrap_err();
        assert!(err.contains("empty"));
    }
}
