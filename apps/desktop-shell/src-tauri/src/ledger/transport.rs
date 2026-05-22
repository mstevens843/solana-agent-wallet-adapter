// `hidapi`-backed implementation of the `HidTransport` trait declared in
// `framing.rs`. Production-only — tests use the mock transport instead.
//
// Ledger Nano S, S Plus, and X all live under vendor id 0x2C97. Multiple
// USB HID interfaces are exposed per device (status, generic, U2F); the
// Solana app responds on the "generic" interface, which we match by
// `usage_page == 0xFFA0` (the Ledger generic HID usage).
//
// `hidapi` write semantics differ slightly across OSes:
//   - macOS / Linux: write expects a leading report-id byte (0x00), so we
//     send 65 bytes per write where bytes [0] = 0 and [1..65] are payload.
//   - Windows: same — `hidapi` normalizes this internally for the system
//     HID stack, so always prefixing 0x00 is safe everywhere.
// Reads return 64 bytes (no report-id prefix on `read_timeout`).

use hidapi::{HidApi, HidDevice};

use super::framing::{HidTransport, PACKET_LEN};

pub const LEDGER_VENDOR_ID: u16 = 0x2C97;
const LEDGER_GENERIC_USAGE_PAGE: u16 = 0xFFA0;

pub struct LedgerHidTransport {
    device: HidDevice,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerDeviceInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: Option<String>,
    pub serial_number: Option<String>,
    pub manufacturer_string: Option<String>,
}

impl LedgerHidTransport {
    /// Enumerate connected Ledger devices (vendor id 0x2C97). Returns the
    /// detected devices' metadata for caller-side logging / UX.
    pub fn list_devices() -> Result<Vec<LedgerDeviceInfo>, String> {
        let api = HidApi::new().map_err(|err| format!("hidapi init: {err}"))?;
        let mut out = Vec::new();
        for info in api.device_list() {
            if info.vendor_id() != LEDGER_VENDOR_ID {
                continue;
            }
            out.push(LedgerDeviceInfo {
                vendor_id: info.vendor_id(),
                product_id: info.product_id(),
                product_name: info.product_string().map(|s| s.to_string()),
                serial_number: info.serial_number().map(|s| s.to_string()),
                manufacturer_string: info.manufacturer_string().map(|s| s.to_string()),
            });
        }
        Ok(out)
    }

    /// Open the first connected Ledger device that exposes the generic HID
    /// usage page (0xFFA0).
    pub fn open_first() -> Result<(Self, LedgerDeviceInfo), String> {
        let api = HidApi::new().map_err(|err| format!("hidapi init: {err}"))?;

        // First try to find the device with the generic HID usage page (the
        // interface the Solana app talks on).
        let preferred = api
            .device_list()
            .find(|info| {
                info.vendor_id() == LEDGER_VENDOR_ID
                    && info.usage_page() == LEDGER_GENERIC_USAGE_PAGE
            });

        // Fallback: just take any Ledger interface. On some platforms
        // `usage_page` is reported as 0; this lets the user try anyway.
        let info = preferred
            .or_else(|| {
                api.device_list()
                    .find(|d| d.vendor_id() == LEDGER_VENDOR_ID)
            })
            .ok_or_else(|| {
                "no Ledger device detected. Plug in your Ledger and open the Solana app.".to_string()
            })?;

        let metadata = LedgerDeviceInfo {
            vendor_id: info.vendor_id(),
            product_id: info.product_id(),
            product_name: info.product_string().map(|s| s.to_string()),
            serial_number: info.serial_number().map(|s| s.to_string()),
            manufacturer_string: info.manufacturer_string().map(|s| s.to_string()),
        };

        let device = info
            .open_device(&api)
            .map_err(|err| format!("hidapi open: {err}"))?;
        Ok((Self { device }, metadata))
    }
}

impl HidTransport for LedgerHidTransport {
    fn write_packet(&mut self, packet: &[u8; PACKET_LEN]) -> Result<(), String> {
        // Leading report-id byte is 0x00. Resulting buffer is 65 bytes.
        let mut framed = [0u8; PACKET_LEN + 1];
        framed[1..].copy_from_slice(packet);
        let written = self
            .device
            .write(&framed)
            .map_err(|err| format!("hidapi write: {err}"))?;
        if written < framed.len() {
            return Err(format!(
                "hidapi short write: wrote {} of {} bytes",
                written,
                framed.len()
            ));
        }
        Ok(())
    }

    fn read_packet(&mut self, timeout_ms: u32) -> Result<[u8; PACKET_LEN], String> {
        let mut buf = [0u8; PACKET_LEN];
        let read = self
            .device
            .read_timeout(&mut buf, timeout_ms as i32)
            .map_err(|err| format!("hidapi read: {err}"))?;
        if read == 0 {
            return Err(
                "Ledger did not respond in time. Check that the USB cable is connected, \
the device is unlocked, and the Solana app is open on-screen, then try again."
                    .into(),
            );
        }
        if read < PACKET_LEN {
            return Err(format!(
                "hidapi short read: got {} bytes (expected {})",
                read, PACKET_LEN
            ));
        }
        Ok(buf)
    }
}
