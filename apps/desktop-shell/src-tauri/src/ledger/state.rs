// Shared Ledger runtime state held behind a `Mutex` in the Tauri app.
//
// Lifecycle: every Tauri command takes the mutex, lazily opens the device
// on first use, runs a single APDU exchange, and releases. We intentionally
// do NOT keep the device open across commands — Ledger devices tolerate
// repeated open/close cycles, and short-lived ownership avoids stranded
// handles if a process panic happens during an exchange.

use std::sync::Mutex;

use rand::RngCore;

use super::apdu::{
    build_get_app_configuration_apdu, build_get_pubkey_apdu, build_sign_apdu,
    build_sign_offchain_message_apdu, encode_derivation_path, parse_app_configuration,
    parse_pubkey, parse_signature, wrap_offchain_message, AppConfiguration,
};
use super::framing::exchange_apdu;
use super::transport::{LedgerDeviceInfo, LedgerHidTransport};

/// Per-command exchange timeout. Generous — signing prompts require the
/// user to physically click buttons on the device.
const READ_TIMEOUT_MS: u32 = 60_000;

/// Intentionally empty — Ledger USB-HID devices are not persistent
/// across IPC calls; every `ledger_*` command opens a fresh `HidApi`
/// context, lists devices, runs its APDU exchange, and closes. The
/// `Mutex<LedgerStateInner>` exists only to serialize concurrent Tauri
/// commands so two requests never touch `HidApi` simultaneously; a unit
/// struct can't be locked, so we wrap an empty named struct instead.
/// If a future slice needs per-device persistent state (cached app
/// version, pinned device serial, etc.) the fields land here.
pub struct LedgerStateInner {}

pub struct LedgerStateHandle(pub Mutex<LedgerStateInner>);

impl Default for LedgerStateHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl LedgerStateHandle {
    pub fn new() -> Self {
        Self(Mutex::new(LedgerStateInner {}))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, LedgerStateInner>, String> {
        self.0
            .lock()
            .map_err(|err| format!("ledger state poisoned: {err}"))
    }
}

fn random_channel() -> u16 {
    // Retry up to 3 times if the RNG happens to return 0 — peer treats
    // channel 0 as a fresh negotiation. A deterministic fallback would
    // hand the peer the same channel id on every command, which works but
    // looks suspicious in a logged packet trace; keeping the value
    // unpredictable is healthier for debugging real device interactions.
    let mut rng = rand::thread_rng();
    for _ in 0..3 {
        let mut bytes = [0u8; 2];
        rng.fill_bytes(&mut bytes);
        let value = u16::from_be_bytes(bytes);
        if value != 0 {
            return value;
        }
    }
    // Three zeros in a row from a healthy RNG is astronomically unlikely.
    // Use 0xBEEF as a less-predictable last-resort fallback than 0xABCD.
    0xBEEF
}

pub fn list_devices(_handle: &LedgerStateHandle) -> Result<Vec<LedgerDeviceInfo>, String> {
    LedgerHidTransport::list_devices()
}

pub struct ConnectedDevice {
    pub metadata: LedgerDeviceInfo,
    pub app_configuration: AppConfiguration,
}

pub fn open_first(handle: &LedgerStateHandle) -> Result<ConnectedDevice, String> {
    let _state = handle.lock()?;
    let (mut transport, metadata) = LedgerHidTransport::open_first()?;
    let channel = random_channel();
    let apdu = build_get_app_configuration_apdu();
    let response = exchange_apdu(&mut transport, channel, &apdu, READ_TIMEOUT_MS)?;
    let app_configuration = parse_app_configuration(&response)?;
    Ok(ConnectedDevice {
        metadata,
        app_configuration,
    })
}

pub struct LedgerAddress {
    pub address: String,
    pub public_key: [u8; 32],
}

pub fn get_address(
    handle: &LedgerStateHandle,
    derivation_path: &str,
    display_on_device: bool,
) -> Result<LedgerAddress, String> {
    let _state = handle.lock()?;
    let (mut transport, _meta) = LedgerHidTransport::open_first()?;
    let channel = random_channel();
    let path_payload = encode_derivation_path(derivation_path)?;
    let apdu = build_get_pubkey_apdu(&path_payload, display_on_device)?;
    let response = exchange_apdu(&mut transport, channel, &apdu, READ_TIMEOUT_MS)?;
    let public_key = parse_pubkey(&response)?;
    let address = bs58::encode(public_key).into_string();
    Ok(LedgerAddress {
        address,
        public_key,
    })
}

pub fn sign_transaction(
    handle: &LedgerStateHandle,
    derivation_path: &str,
    transaction: &[u8],
) -> Result<[u8; 64], String> {
    let _state = handle.lock()?;
    let (mut transport, _meta) = LedgerHidTransport::open_first()?;
    let channel = random_channel();
    let path_payload = encode_derivation_path(derivation_path)?;
    let apdu = build_sign_apdu(&path_payload, transaction)?;
    let response = exchange_apdu(&mut transport, channel, &apdu, READ_TIMEOUT_MS)?;
    parse_signature(&response)
}

/// Sign an off-chain message via INS=0x07. Wraps the user-supplied bytes in
/// the SIMD-32 envelope before sending. Used by SIWS-style sign-in flows
/// that need a signature but no transaction.
pub fn sign_offchain_message(
    handle: &LedgerStateHandle,
    derivation_path: &str,
    message: &[u8],
) -> Result<[u8; 64], String> {
    let _state = handle.lock()?;
    let (mut transport, _meta) = LedgerHidTransport::open_first()?;
    let channel = random_channel();
    let path_payload = encode_derivation_path(derivation_path)?;
    let enveloped = wrap_offchain_message(message)?;
    let apdu = build_sign_offchain_message_apdu(&path_payload, &enveloped)?;
    let response = exchange_apdu(&mut transport, channel, &apdu, READ_TIMEOUT_MS)?;
    parse_signature(&response)
}
