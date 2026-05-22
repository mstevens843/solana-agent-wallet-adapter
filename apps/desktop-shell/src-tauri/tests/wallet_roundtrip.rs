// Integration test: full embedded-wallet lifecycle across simulated process
// restarts. Per-module unit tests already cover the small-step invariants
// (crypto round-trip, file perms, password rejection). This file exercises
// the cross-module flow that mirrors how the Tauri commands will actually
// be sequenced in production:
//
//   1. New machine: create wallet → mnemonic shown once → wallet unlocked
//   2. Simulated restart: drop state, reload from disk → wallet locked
//   3. Unlock with password → sign a message → verify with ed25519
//   4. Lock, then unlock with wrong password → "invalid password"
//   5. Change password → old password rejected, new password works
//
// Uses `DeviceKeySource::InMemory` to avoid touching the real OS keychain
// during CI / `cargo test`.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use solana_agent_wallet_desktop_lib::wallet::{
    keychain::DeviceKeySource,
    state::{WalletState, DEFAULT_AUTO_LOCK_SECS},
};
use tempfile::TempDir;

const DEVICE_KEY: [u8; 32] = [0xAB; 32];

fn fresh_state(dir: &TempDir) -> WalletState {
    let path = dir.path().join("desktop-wallet.json");
    WalletState::new(
        path,
        DeviceKeySource::InMemory(DEVICE_KEY),
        DEFAULT_AUTO_LOCK_SECS,
    )
}

#[test]
fn full_lifecycle_across_restart() {
    let dir = TempDir::new().unwrap();

    // 1. Create on a fresh machine.
    let address;
    let phrase;
    {
        let mut state = fresh_state(&dir);
        let created = state.create("hunter2").unwrap();
        address = created.address.clone();
        phrase = created.mnemonic.clone();
        assert_eq!(phrase.split_whitespace().count(), 24);
        let status = state.status().unwrap();
        assert!(status.exists);
        assert!(status.unlocked);
        assert_eq!(status.address.as_deref(), Some(address.as_str()));
    }

    // 2. Restart: new state object reads the same wallet file from disk.
    let mut state = fresh_state(&dir);
    let status = state.status().unwrap();
    assert!(status.exists, "wallet file persisted across restart");
    assert!(!status.unlocked, "wallet is locked after restart");
    assert_eq!(status.address.as_deref(), Some(address.as_str()));

    // 3. Unlock with right password; sign; verify.
    state.unlock("hunter2").unwrap();
    let message = b"agentic restart roundtrip";
    let sig_bytes = state.sign_message(&address, message).unwrap();
    let signature = Signature::from_bytes(&sig_bytes);
    let pubkey_bytes = bs58::decode(&address).into_vec().unwrap();
    let verifying = VerifyingKey::from_bytes(&pubkey_bytes.try_into().unwrap()).unwrap();
    verifying
        .verify(message, &signature)
        .expect("ed25519 signature verifies");

    // 4. Lock, then wrong password rejected.
    state.lock().unwrap();
    let err = state.unlock("wrong").unwrap_err();
    assert_eq!(err, "invalid password");

    // 5. Re-unlock with correct password, change it, old rejected, new works.
    state.unlock("hunter2").unwrap();
    state.change_password("hunter2", "rotated!").unwrap();
    state.lock().unwrap();
    assert!(state.unlock("hunter2").is_err());
    state.unlock("rotated!").unwrap();
    assert_eq!(state.status().unwrap().address.as_deref(), Some(address.as_str()));
}

#[test]
fn imported_mnemonic_produces_same_address_on_a_new_machine() {
    // Simulate the "I got a new laptop" flow: take the mnemonic from machine
    // A, import it on machine B (different keychain device key), and confirm
    // the address derives identically. The device key MUST be irrelevant to
    // the address derivation — it's only used for KEK derivation.

    let dir_a = TempDir::new().unwrap();
    let phrase;
    let address;
    {
        let mut state = fresh_state(&dir_a);
        let created = state.create("alpha").unwrap();
        phrase = created.mnemonic.clone();
        address = created.address.clone();
    }

    // Different machine = different device key, different password, different
    // wallet file path. Only the mnemonic carries over.
    let dir_b = TempDir::new().unwrap();
    let mut state_b = WalletState::new(
        dir_b.path().join("desktop-wallet.json"),
        DeviceKeySource::InMemory([0x99; 32]), // different device key
        DEFAULT_AUTO_LOCK_SECS,
    );
    let imported = state_b.import("beta", &phrase).unwrap();
    assert_eq!(imported.address, address, "address must derive identically from mnemonic alone");

    // And the new machine can sign with the imported wallet.
    let sig_bytes = state_b
        .sign_message(&address, b"new machine, same wallet")
        .unwrap();
    let signature = Signature::from_bytes(&sig_bytes);
    let pubkey_bytes = bs58::decode(&address).into_vec().unwrap();
    let verifying = VerifyingKey::from_bytes(&pubkey_bytes.try_into().unwrap()).unwrap();
    verifying
        .verify(b"new machine, same wallet", &signature)
        .expect("imported wallet signature verifies");
}

#[test]
fn export_mnemonic_after_restart_returns_original_phrase() {
    let dir = TempDir::new().unwrap();
    let phrase;
    {
        let mut state = fresh_state(&dir);
        phrase = state.create("p").unwrap().mnemonic;
    }
    let mut state = fresh_state(&dir);
    let exported = state.export_mnemonic("p").unwrap();
    assert_eq!(exported, phrase);
}

#[test]
fn delete_then_status_reports_no_wallet() {
    let dir = TempDir::new().unwrap();
    let mut state = fresh_state(&dir);
    state.create("p").unwrap();
    assert!(state.status().unwrap().exists);
    state.delete_wallet("p").unwrap();
    let status = state.status().unwrap();
    assert!(!status.exists);
    assert!(!status.unlocked);
    assert!(status.address.is_none());
}
