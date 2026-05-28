// Ledger USB-HID hardware wallet integration (Slice G).
//
// Layered as: `transport.rs` (hidapi) → `framing.rs` (Ledger HID packet
// framing) → `apdu.rs` (Solana app APDU encoding) → `state.rs` (per-command
// orchestration) → this file (`mod.rs` — the Tauri IPC surface).
//
// Slice G v1 ships:
//   - `ledger_list_devices` — enumerate plugged-in Ledger devices
//   - `ledger_connect`      — open the first available device + read the
//                             Solana app version (verifies the right app
//                             is open before the user proceeds)
//   - `ledger_get_address`  — derive the address at a BIP-32 path
//   - `ledger_sign_transaction` — sign a Solana transaction's message bytes
//
// `ledger_sign_message` uses INS 0x07 with the Solana off-chain message
// envelope; proof-only browser flows may still prefer memo-transaction proofs
// for wallet compatibility.

pub mod apdu;
pub mod framing;
pub mod state;
pub mod transport;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};

pub use state::LedgerStateHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerDevice {
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: Option<String>,
    pub serial_number: Option<String>,
    pub manufacturer_string: Option<String>,
}

impl From<transport::LedgerDeviceInfo> for LedgerDevice {
    fn from(info: transport::LedgerDeviceInfo) -> Self {
        Self {
            vendor_id: info.vendor_id,
            product_id: info.product_id,
            product_name: info.product_name,
            serial_number: info.serial_number,
            manufacturer_string: info.manufacturer_string,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAppConfig {
    pub flags: u8,
    pub pub_key_display_mode: Option<u8>,
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
}

impl From<apdu::AppConfiguration> for LedgerAppConfig {
    fn from(config: apdu::AppConfiguration) -> Self {
        Self {
            flags: config.flags,
            pub_key_display_mode: config.pub_key_display_mode,
            major: config.major,
            minor: config.minor,
            patch: config.patch,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerConnectResult {
    pub device: LedgerDevice,
    pub app: LedgerAppConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAddressResult {
    pub address: String,
    /// Base64-encoded raw 32-byte ed25519 public key.
    pub public_key_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerDerivedAddress {
    pub derivation_path: String,
    pub address: String,
    /// Base64-encoded raw 32-byte ed25519 public key.
    pub public_key_b64: String,
}

// ────────────────────────────────────────────────────────────────────────
// Tauri commands
// ────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn ledger_list_devices(
    handle: tauri::State<'_, LedgerStateHandle>,
) -> Result<Vec<LedgerDevice>, String> {
    Ok(state::list_devices(&handle)?
        .into_iter()
        .map(LedgerDevice::from)
        .collect())
}

#[tauri::command]
pub fn ledger_connect(
    handle: tauri::State<'_, LedgerStateHandle>,
) -> Result<LedgerConnectResult, String> {
    let connected = state::open_first(&handle)?;
    Ok(LedgerConnectResult {
        device: connected.metadata.into(),
        app: connected.app_configuration.into(),
    })
}

#[tauri::command]
pub fn ledger_get_address(
    handle: tauri::State<'_, LedgerStateHandle>,
    derivation_path: String,
    display_on_device: Option<bool>,
) -> Result<LedgerAddressResult, String> {
    let display = display_on_device.unwrap_or(false);
    let address = state::get_address(&handle, &derivation_path, display)?;
    Ok(LedgerAddressResult {
        address: address.address,
        public_key_b64: B64.encode(address.public_key),
    })
}

#[tauri::command]
pub fn ledger_get_addresses(
    handle: tauri::State<'_, LedgerStateHandle>,
    derivation_paths: Vec<String>,
) -> Result<Vec<LedgerDerivedAddress>, String> {
    Ok(state::get_addresses(&handle, &derivation_paths)?
        .into_iter()
        .map(|address| LedgerDerivedAddress {
            derivation_path: address.derivation_path,
            address: address.address,
            public_key_b64: B64.encode(address.public_key),
        })
        .collect())
}

#[tauri::command]
pub fn ledger_sign_transaction(
    handle: tauri::State<'_, LedgerStateHandle>,
    derivation_path: String,
    transaction_b64: String,
) -> Result<String, String> {
    let transaction = B64
        .decode(&transaction_b64)
        .map_err(|err| format!("transaction_b64 invalid: {err}"))?;
    let signature = state::sign_transaction(&handle, &derivation_path, &transaction)?;
    Ok(B64.encode(signature))
}

#[tauri::command]
pub fn ledger_sign_message(
    handle: tauri::State<'_, LedgerStateHandle>,
    derivation_path: String,
    message_b64: String,
) -> Result<String, String> {
    let message = B64
        .decode(&message_b64)
        .map_err(|err| format!("message_b64 invalid: {err}"))?;
    let signature = state::sign_offchain_message(&handle, &derivation_path, &message)?;
    Ok(B64.encode(signature))
}

#[tauri::command]
pub fn ledger_disconnect() -> Result<(), String> {
    // No-op for now: `state.rs` does not keep the device open across
    // commands, so there's nothing to release. Exposed as a Tauri command
    // anyway so the TS layer can ask for tear-down symmetrically.
    Ok(())
}
