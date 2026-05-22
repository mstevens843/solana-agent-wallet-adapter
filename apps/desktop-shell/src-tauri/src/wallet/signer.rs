// BIP-39 mnemonic ↔ BIP-44 (`m/44'/501'/0'/0'`) ↔ ed25519 keypair, plus sign.
//
// Solana wallets (Phantom/Solflare/Backpack) standardize on the BIP-44 path
// `m/44'/501'/0'/0'` for the first account. All four levels are hardened —
// ed25519 per SLIP-0010 only supports hardened derivation. This module
// matches that exactly so a 24-word seed imported here resolves to the same
// public address it would in any of those wallets.
//
// Inputs (mnemonic, password) never leave this module's owned buffers; the
// secret-key bytes returned are wrapped in `Zeroizing` and overwritten on
// drop. The public address (base58 ed25519 public key) is the only
// non-secret output.

use bip39::{Language, Mnemonic};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::Sha512;
use zeroize::Zeroizing;

/// Default Solana wallet derivation path indices (without the hardened flag —
/// `slip10_derive_ed25519` applies it). Equals `m/44'/501'/0'/0'`.
pub const SOLANA_DERIVATION_PATH: &[u32] = &[44, 501, 0, 0];

/// String form of the derivation path, persisted in the storage envelope so
/// future migrations can re-derive deterministically.
pub const SOLANA_DERIVATION_PATH_STR: &str = "m/44'/501'/0'/0'";

/// Word count for newly-generated wallets. 24 words = 256 bits of entropy.
pub const MNEMONIC_WORD_COUNT: usize = 24;

/// A loaded, in-memory keypair for the active wallet.
///
/// `signing_key` zeroizes on drop. `address` is the base58 public key (safe to
/// log/show in UI).
pub struct LoadedKeypair {
    pub address: String,
    #[allow(dead_code)] // exposed for tests; future Slice B will use it for proof signing checks.
    pub public_key: VerifyingKey,
    pub signing_key: Zeroizing<[u8; 32]>,
}

impl LoadedKeypair {
    /// Sign an arbitrary message and return the 64-byte ed25519 signature.
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        let signing = SigningKey::from_bytes(&self.signing_key);
        signing.sign(message).to_bytes()
    }
}

/// Generate a fresh 24-word BIP-39 mnemonic (English).
pub fn generate_mnemonic() -> Result<Mnemonic, String> {
    Mnemonic::generate_in(Language::English, MNEMONIC_WORD_COUNT)
        .map_err(|err| format!("mnemonic generate: {err}"))
}

/// Parse a user-supplied mnemonic string. Whitespace-tolerant; rejects bad
/// checksums and unknown words.
pub fn parse_mnemonic(input: &str) -> Result<Mnemonic, String> {
    let trimmed = input.split_whitespace().collect::<Vec<_>>().join(" ");
    Mnemonic::parse_in(Language::English, &trimmed)
        .map_err(|err| format!("mnemonic invalid: {err}"))
}

/// Convert a mnemonic to a 64-byte seed via BIP-39 PBKDF2 with empty
/// passphrase (matches Phantom/Solflare/Backpack defaults).
pub fn mnemonic_to_seed(mnemonic: &Mnemonic) -> [u8; 64] {
    mnemonic.to_seed_normalized("")
}

/// Derive an ed25519 keypair at the default Solana path. Returns the loaded
/// keypair with a `Zeroizing` private key buffer.
pub fn derive_keypair(seed: &[u8; 64]) -> Result<LoadedKeypair, String> {
    derive_keypair_at_path(seed, SOLANA_DERIVATION_PATH)
}

/// Lower-level: derive at an explicit path. Used by tests.
pub fn derive_keypair_at_path(seed: &[u8], indices: &[u32]) -> Result<LoadedKeypair, String> {
    let secret = slip10_derive_ed25519(seed, indices)?;
    let signing = SigningKey::from_bytes(&secret);
    let verifying = signing.verifying_key();
    let address = bs58::encode(verifying.as_bytes()).into_string();
    Ok(LoadedKeypair {
        address,
        public_key: verifying,
        signing_key: Zeroizing::new(secret),
    })
}

/// SLIP-0010 ed25519 derivation. All indices are forcibly hardened (the spec
/// disallows non-hardened ed25519 derivation).
fn slip10_derive_ed25519(seed: &[u8], indices: &[u32]) -> Result<[u8; 32], String> {
    if seed.is_empty() {
        return Err("empty seed".into());
    }
    type HmacSha512 = Hmac<Sha512>;

    // Master node: HMAC-SHA512("ed25519 seed", seed)
    let mut mac =
        HmacSha512::new_from_slice(b"ed25519 seed").map_err(|err| format!("hmac init: {err}"))?;
    mac.update(seed);
    let master = mac.finalize().into_bytes();
    let mut key = <[u8; 32]>::try_from(&master[..32])
        .map_err(|err| format!("master key length: {err}"))?;
    let mut chain_code = <[u8; 32]>::try_from(&master[32..])
        .map_err(|err| format!("master chain code length: {err}"))?;

    for &index in indices {
        let hardened = index | 0x8000_0000;
        let mut mac = HmacSha512::new_from_slice(&chain_code)
            .map_err(|err| format!("hmac child init: {err}"))?;
        // SLIP-0010: data = 0x00 || ser256(k_par) || ser32(i)
        mac.update(&[0x00]);
        mac.update(&key);
        mac.update(&hardened.to_be_bytes());
        let child = mac.finalize().into_bytes();
        key = <[u8; 32]>::try_from(&child[..32])
            .map_err(|err| format!("child key length: {err}"))?;
        chain_code = <[u8; 32]>::try_from(&child[32..])
            .map_err(|err| format!("child chain code length: {err}"))?;
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    #[test]
    fn generated_mnemonic_is_24_words() {
        let mnemonic = generate_mnemonic().unwrap();
        let words: Vec<&str> = mnemonic.words().collect();
        assert_eq!(words.len(), MNEMONIC_WORD_COUNT);
    }

    #[test]
    fn parse_then_serialize_round_trip() {
        let mnemonic = generate_mnemonic().unwrap();
        let s = mnemonic.to_string();
        let parsed = parse_mnemonic(&s).unwrap();
        assert_eq!(parsed.to_string(), s);
    }

    #[test]
    fn parse_rejects_bad_checksum() {
        // Valid English words but the checksum word will fail for most random
        // 24-word permutations of "abandon".
        let bad =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
        let err = parse_mnemonic(bad).unwrap_err();
        assert!(err.contains("invalid"));
    }

    #[test]
    fn parse_tolerates_extra_whitespace() {
        let mnemonic = generate_mnemonic().unwrap();
        let messy = format!("  {}\n", mnemonic.to_string().replace(' ', "\t "));
        let parsed = parse_mnemonic(&messy).unwrap();
        assert_eq!(parsed.to_string(), mnemonic.to_string());
    }

    #[test]
    fn derived_keypair_address_is_base58() {
        let mnemonic = generate_mnemonic().unwrap();
        let seed = mnemonic_to_seed(&mnemonic);
        let kp = derive_keypair(&seed).unwrap();
        // Solana addresses decode to 32 bytes.
        let decoded = bs58::decode(&kp.address).into_vec().unwrap();
        assert_eq!(decoded.len(), 32);
        assert_eq!(decoded.as_slice(), kp.public_key.as_bytes());
    }

    #[test]
    fn signature_verifies_against_public_key() {
        let mnemonic = generate_mnemonic().unwrap();
        let seed = mnemonic_to_seed(&mnemonic);
        let kp = derive_keypair(&seed).unwrap();
        let msg = b"hello, agentic";
        let sig_bytes = kp.sign(msg);
        let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
        kp.public_key.verify(msg, &sig).expect("signature verifies");
    }

    #[test]
    fn same_mnemonic_derives_same_address_deterministically() {
        let mnemonic = generate_mnemonic().unwrap();
        let phrase = mnemonic.to_string();
        let seed = mnemonic_to_seed(&mnemonic);
        let address_a = derive_keypair(&seed).unwrap().address;

        let reparsed = parse_mnemonic(&phrase).unwrap();
        let seed2 = mnemonic_to_seed(&reparsed);
        let address_b = derive_keypair(&seed2).unwrap().address;
        assert_eq!(address_a, address_b);
    }

    #[test]
    fn different_paths_give_different_addresses() {
        let mnemonic = generate_mnemonic().unwrap();
        let seed = mnemonic_to_seed(&mnemonic);
        let kp_default = derive_keypair_at_path(&seed, &[44, 501, 0, 0]).unwrap();
        let kp_account_1 = derive_keypair_at_path(&seed, &[44, 501, 1, 0]).unwrap();
        assert_ne!(kp_default.address, kp_account_1.address);
    }
}
