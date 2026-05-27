// Solana Ledger app APDU encoding (Slice G).
//
// References:
//   - https://github.com/LedgerHQ/app-solana/blob/develop/docs/apdu.md
//   - @ledgerhq/hw-app-solana
//
// CLA = 0xE0. Each instruction takes P1 / P2 plus an Lc-prefixed payload.
// For SIGN, the payload is `derivation_path || transaction_bytes`. The
// derivation path encoding is:
//
//   [path_count: u8][index_be_u32 with high bit set for hardened][..]
//
// e.g. `m/44'/501'/0'/0'` →
//   04 | 8000002C | 800001F5 | 80000000 | 80000000  (17 bytes)
//
// Responses end with a 2-byte status word (SW1/SW2). `0x9000` = success.

pub const CLA: u8 = 0xE0;
pub const INS_GET_APP_CONFIGURATION: u8 = 0x04;
pub const INS_GET_PUBKEY: u8 = 0x05;
pub const INS_SIGN_MESSAGE: u8 = 0x06;
pub const INS_SIGN_OFFCHAIN_MESSAGE: u8 = 0x07;
pub const SW_SUCCESS: u16 = 0x9000;
pub const SW_USER_REJECTED: u16 = 0x6985;
pub const SW_BLIND_SIGNATURE_REQUIRED: u16 = 0x6808;
const P1_NON_CONFIRM: u8 = 0x00;
const P1_CONFIRM: u8 = 0x01;
const P2_EXTEND: u8 = 0x01;
const P2_MORE: u8 = 0x02;
const MAX_APDU_PAYLOAD: usize = 255;
/// Solana's default derivation path (matches Phantom / Solflare / Backpack).
pub const SOLANA_DEFAULT_PATH: &str = "m/44'/501'/0'/0'";

/// Off-chain message envelope per Solana SIMD-32.
///
/// Wire format: `\xffsolana offchain` (16-byte magic), version (u8),
/// format (u8), length (u16 little-endian), message bytes.
///
/// The Ledger Solana app validates the envelope before showing the user a
/// confirm prompt. We wrap arbitrary `message_bytes` in the v0 envelope
/// with format auto-selected (restricted ASCII when possible, UTF-8
/// otherwise). Non-printable bytes are displayed on-device as a hash.
pub const OFFCHAIN_MESSAGE_MAGIC: &[u8] = b"\xffsolana offchain";
pub const OFFCHAIN_MESSAGE_VERSION: u8 = 0;
pub const OFFCHAIN_MESSAGE_FORMAT_RESTRICTED_ASCII: u8 = 0;
pub const OFFCHAIN_MESSAGE_FORMAT_UTF8: u8 = 1;

/// Encode a BIP-32 path (e.g. `m/44'/501'/0'/0'`) as the count-prefixed
/// hardened-index format the Ledger Solana app expects. All path components
/// are hardened; the encoder rejects unhardened ones to catch caller bugs
/// early (the Solana app would reject them anyway).
pub fn encode_derivation_path(path: &str) -> Result<Vec<u8>, String> {
    let trimmed = path.trim();
    let body = trimmed.strip_prefix("m/").unwrap_or(trimmed);
    if body.is_empty() {
        return Err("derivation path is empty".into());
    }
    let parts: Vec<&str> = body.split('/').collect();
    if parts.len() > u8::MAX as usize {
        return Err("derivation path is too deep".into());
    }
    let mut out = Vec::with_capacity(1 + 4 * parts.len());
    out.push(parts.len() as u8);
    for part in parts {
        let (numeric, hardened) = if let Some(stripped) = part.strip_suffix('\'') {
            (stripped, true)
        } else if let Some(stripped) = part.strip_suffix('h') {
            (stripped, true)
        } else {
            (part, false)
        };
        if !hardened {
            return Err(format!(
                "derivation path component '{part}' is not hardened — Solana on Ledger requires hardened indices throughout"
            ));
        }
        let idx: u32 = numeric
            .parse()
            .map_err(|err| format!("derivation path component '{part}' is not a u32: {err}"))?;
        if idx & 0x8000_0000 != 0 {
            return Err(format!(
                "derivation path component '{part}' already has the hardened bit set; pass the unflagged index"
            ));
        }
        out.extend_from_slice(&(idx | 0x8000_0000).to_be_bytes());
    }
    Ok(out)
}

/// Build a Get-Public-Key APDU. `display_on_device`: when `true`, the
/// device prompts the user to confirm before returning the key.
pub fn build_get_pubkey_apdu(path_payload: &[u8], display_on_device: bool) -> Result<Vec<u8>, String> {
    if path_payload.len() > u8::MAX as usize {
        return Err("path payload too long for short APDU".into());
    }
    build_short_apdu(
        INS_GET_PUBKEY,
        if display_on_device { P1_CONFIRM } else { P1_NON_CONFIRM },
        0x00,
        path_payload,
    )
}

/// Build Solana app SIGN APDUs. Ledger's Solana app expects a signer-path
/// count byte before the encoded BIP-32 path, then the full serialized
/// transaction. Payloads over 255 bytes are split across multiple APDUs with
/// P2_MORE / P2_EXTEND in the same shape as `@ledgerhq/hw-app-solana`.
pub fn build_sign_apdus(path_payload: &[u8], transaction: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    build_chunked_signing_apdus(INS_SIGN_MESSAGE, path_payload, transaction)
}

/// Build the Get-App-Configuration APDU (handy for checking the Solana
/// app is open + reporting its version).
pub fn build_get_app_configuration_apdu() -> Vec<u8> {
    vec![CLA, INS_GET_APP_CONFIGURATION, 0x00, 0x00, 0x00]
}

/// Wrap `message` in the SIMD-32 off-chain message envelope. `format` is
/// auto-detected from the bytes: if every byte is printable ASCII (0x20–0x7E,
/// tab, newline) we send the restricted-ASCII format (which lets older
/// Ledger firmware display it inline); otherwise we send UTF-8 (which newer
/// firmware accepts but older firmware will hash + ask the user to confirm
/// the hash).
pub fn wrap_offchain_message(message: &[u8]) -> Result<Vec<u8>, String> {
    if message.len() > u16::MAX as usize {
        return Err(format!(
            "off-chain message {} bytes exceeds u16 max ({})",
            message.len(),
            u16::MAX,
        ));
    }
    let format = if message
        .iter()
        .all(|&b| matches!(b, 0x20..=0x7E | b'\t' | b'\n'))
    {
        OFFCHAIN_MESSAGE_FORMAT_RESTRICTED_ASCII
    } else {
        OFFCHAIN_MESSAGE_FORMAT_UTF8
    };
    let mut out = Vec::with_capacity(OFFCHAIN_MESSAGE_MAGIC.len() + 4 + message.len());
    out.extend_from_slice(OFFCHAIN_MESSAGE_MAGIC);
    out.push(OFFCHAIN_MESSAGE_VERSION);
    out.push(format);
    out.extend_from_slice(&(message.len() as u16).to_le_bytes());
    out.extend_from_slice(message);
    Ok(out)
}

/// Build a Sign-Off-Chain-Message APDU. Single-chunk variant — same 255-byte
/// Lc ceiling as `build_sign_apdu`.
pub fn build_sign_offchain_message_apdu(
    path_payload: &[u8],
    enveloped_message: &[u8],
) -> Result<Vec<Vec<u8>>, String> {
    build_chunked_signing_apdus(INS_SIGN_OFFCHAIN_MESSAGE, path_payload, enveloped_message)
}

fn build_chunked_signing_apdus(
    instruction: u8,
    path_payload: &[u8],
    payload: &[u8],
) -> Result<Vec<Vec<u8>>, String> {
    let mut signing_payload = Vec::with_capacity(1 + path_payload.len() + payload.len());
    signing_payload.push(1); // one signer path
    signing_payload.extend_from_slice(path_payload);
    signing_payload.extend_from_slice(payload);
    build_chunked_apdus(instruction, P1_CONFIRM, &signing_payload)
}

fn build_chunked_apdus(instruction: u8, p1: u8, payload: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    if payload.is_empty() {
        return build_short_apdu(instruction, p1, 0x00, payload).map(|apdu| vec![apdu]);
    }
    let mut out = Vec::new();
    let mut offset = 0usize;
    let mut p2 = 0u8;
    while payload.len() - offset > MAX_APDU_PAYLOAD {
        let chunk = &payload[offset..offset + MAX_APDU_PAYLOAD];
        out.push(build_short_apdu(instruction, p1, p2 | P2_MORE, chunk)?);
        offset += MAX_APDU_PAYLOAD;
        p2 |= P2_EXTEND;
    }
    out.push(build_short_apdu(instruction, p1, p2, &payload[offset..])?);
    Ok(out)
}

fn build_short_apdu(instruction: u8, p1: u8, p2: u8, payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_APDU_PAYLOAD {
        return Err(format!(
            "APDU payload {} bytes exceeds short-form limit ({MAX_APDU_PAYLOAD})",
            payload.len(),
        ));
    }
    let mut apdu = Vec::with_capacity(5 + payload.len());
    apdu.push(CLA);
    apdu.push(instruction);
    apdu.push(p1);
    apdu.push(p2);
    apdu.push(payload.len() as u8);
    apdu.extend_from_slice(payload);
    Ok(apdu)
}

/// Split a Ledger response into payload + status word. Returns `Err` with a
/// human-readable message for non-success SWs.
pub fn parse_response(response: &[u8]) -> Result<&[u8], String> {
    if response.len() < 2 {
        return Err(format!(
            "ledger response too short ({} bytes), expected at least 2-byte SW",
            response.len()
        ));
    }
    let sw = u16::from_be_bytes([
        response[response.len() - 2],
        response[response.len() - 1],
    ]);
    if sw == SW_SUCCESS {
        return Ok(&response[..response.len() - 2]);
    }
    Err(match sw {
        SW_USER_REJECTED => "user rejected on device".to_string(),
        0x6700 => "incorrect APDU length".to_string(),
        0x6800 | 0x6802 => "other instruction needed first".to_string(),
        SW_BLIND_SIGNATURE_REQUIRED => {
            "blind signing is disabled in the Ledger Solana app settings".to_string()
        }
        0x5515 => "Ledger is locked. Unlock the device and keep the Solana app open.".to_string(),
        0x6982 => "security status not satisfied (device locked?)".to_string(),
        0x6A82 | 0x6D00 => {
            "instruction not supported — is the Solana app open on the device?".to_string()
        }
        0x6B00 => "incorrect P1/P2".to_string(),
        other => format!("ledger returned SW {other:#06X}"),
    })
}

/// Parsed output of `INS_GET_APP_CONFIGURATION`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppConfiguration {
    pub flags: u8,
    pub pub_key_display_mode: Option<u8>,
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
}

pub fn parse_app_configuration(response: &[u8]) -> Result<AppConfiguration, String> {
    let payload = parse_response(response)?;
    if payload.len() < 4 {
        return Err(format!(
            "GET_APP_CONFIGURATION payload too short ({} bytes)",
            payload.len()
        ));
    }
    if payload.len() >= 5 {
        return Ok(AppConfiguration {
            flags: payload[0],
            pub_key_display_mode: Some(payload[1]),
            major: payload[2],
            minor: payload[3],
            patch: payload[4],
        });
    }
    Ok(AppConfiguration {
        flags: payload[0],
        pub_key_display_mode: None,
        major: payload[1],
        minor: payload[2],
        patch: payload[3],
    })
}

/// Parse the public-key response. Returns a 32-byte ed25519 pubkey.
pub fn parse_pubkey(response: &[u8]) -> Result<[u8; 32], String> {
    let payload = parse_response(response)?;
    if payload.len() < 32 {
        return Err(format!(
            "GET_PUBKEY payload too short ({} bytes); expected at least 32",
            payload.len()
        ));
    }
    // Many Ledger apps include extra fields (chain code, etc.) after the
    // pubkey; we take the first 32 bytes, which is the standard.
    let mut out = [0u8; 32];
    out.copy_from_slice(&payload[..32]);
    Ok(out)
}

/// Parse the signature response. Returns a 64-byte ed25519 signature.
pub fn parse_signature(response: &[u8]) -> Result<[u8; 64], String> {
    let payload = parse_response(response)?;
    if payload.len() != 64 {
        return Err(format!(
            "SIGN_MESSAGE payload length {} != expected 64",
            payload.len()
        ));
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(payload);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_derivation_path_default() {
        let bytes = encode_derivation_path(SOLANA_DEFAULT_PATH).unwrap();
        assert_eq!(
            bytes,
            vec![
                0x04, 0x80, 0x00, 0x00, 0x2C, 0x80, 0x00, 0x01, 0xF5, 0x80, 0x00, 0x00, 0x00, 0x80,
                0x00, 0x00, 0x00,
            ]
        );
    }

    #[test]
    fn encode_derivation_path_three_levels() {
        let bytes = encode_derivation_path("m/44'/501'/0'").unwrap();
        assert_eq!(
            bytes,
            vec![
                0x03, 0x80, 0x00, 0x00, 0x2C, 0x80, 0x00, 0x01, 0xF5, 0x80, 0x00, 0x00, 0x00,
            ]
        );
    }

    #[test]
    fn encode_derivation_path_accepts_h_suffix_for_hardened() {
        let bytes = encode_derivation_path("m/44h/501h/0h/0h").unwrap();
        // Identical to the apostrophe form.
        assert_eq!(bytes, encode_derivation_path(SOLANA_DEFAULT_PATH).unwrap());
    }

    #[test]
    fn encode_derivation_path_rejects_unhardened() {
        let err = encode_derivation_path("m/44'/501/0'/0'").unwrap_err();
        assert!(err.contains("not hardened"));
    }

    #[test]
    fn encode_derivation_path_rejects_already_flagged_indices() {
        let err = encode_derivation_path("m/2147483692'").unwrap_err();
        assert!(err.contains("hardened bit set"));
    }

    #[test]
    fn build_get_pubkey_apdu_short_form() {
        let path = encode_derivation_path(SOLANA_DEFAULT_PATH).unwrap();
        let apdu = build_get_pubkey_apdu(&path, false).unwrap();
        assert_eq!(apdu[0], CLA);
        assert_eq!(apdu[1], INS_GET_PUBKEY);
        assert_eq!(apdu[2], 0x00);
        assert_eq!(apdu[3], 0x00);
        assert_eq!(apdu[4] as usize, path.len());
        assert_eq!(&apdu[5..], path.as_slice());

        let apdu_display = build_get_pubkey_apdu(&path, true).unwrap();
        assert_eq!(apdu_display[2], 0x01);
    }

    #[test]
    fn build_sign_apdus_short_form() {
        let path = encode_derivation_path(SOLANA_DEFAULT_PATH).unwrap();
        let tx = vec![0xAAu8; 64];
        let apdus = build_sign_apdus(&path, &tx).unwrap();
        assert_eq!(apdus.len(), 1);
        let apdu = &apdus[0];
        assert_eq!(apdu[0], CLA);
        assert_eq!(apdu[1], INS_SIGN_MESSAGE);
        assert_eq!(apdu[2], P1_CONFIRM);
        assert_eq!(apdu[3], 0x00);
        assert_eq!(apdu[4] as usize, 1 + path.len() + tx.len());
        assert_eq!(apdu[5], 1);
        assert_eq!(&apdu[6..6 + path.len()], path.as_slice());
        assert_eq!(&apdu[6 + path.len()..], tx.as_slice());
    }

    #[test]
    fn build_sign_apdus_chunks_overlong_payload() {
        let path = encode_derivation_path(SOLANA_DEFAULT_PATH).unwrap();
        let tx = vec![0xAAu8; 250];
        let apdus = build_sign_apdus(&path, &tx).unwrap();
        assert_eq!(apdus.len(), 2);
        assert_eq!(apdus[0][1], INS_SIGN_MESSAGE);
        assert_eq!(apdus[0][2], P1_CONFIRM);
        assert_eq!(apdus[0][3], P2_MORE);
        assert_eq!(apdus[0][4] as usize, MAX_APDU_PAYLOAD);
        assert_eq!(apdus[1][3], P2_EXTEND);
    }

    #[test]
    fn parse_response_returns_payload_on_success() {
        let response = vec![0xDE, 0xAD, 0x90, 0x00];
        assert_eq!(parse_response(&response).unwrap(), &[0xDE, 0xAD]);
    }

    #[test]
    fn parse_response_user_rejected() {
        let err = parse_response(&[0x69, 0x85]).unwrap_err();
        assert!(err.contains("user rejected"));
    }

    #[test]
    fn parse_response_locked_device() {
        let err = parse_response(&[0x55, 0x15]).unwrap_err();
        assert!(err.contains("locked"));
    }

    #[test]
    fn parse_response_app_not_open() {
        let err = parse_response(&[0x6D, 0x00]).unwrap_err();
        assert!(err.contains("Solana app open"));
    }

    #[test]
    fn parse_pubkey_extracts_32_bytes() {
        let mut response = vec![0u8; 32];
        for (i, b) in response.iter_mut().enumerate() {
            *b = i as u8;
        }
        response.push(0x90);
        response.push(0x00);
        let pubkey = parse_pubkey(&response).unwrap();
        assert_eq!(pubkey[0], 0);
        assert_eq!(pubkey[31], 31);
    }

    #[test]
    fn parse_signature_requires_exactly_64_bytes() {
        let mut response = vec![0u8; 64];
        response.push(0x90);
        response.push(0x00);
        assert!(parse_signature(&response).is_ok());

        let mut short = vec![0u8; 32];
        short.push(0x90);
        short.push(0x00);
        let err = parse_signature(&short).unwrap_err();
        assert!(err.contains("length"));
    }

    #[test]
    fn parse_app_configuration_extracts_version() {
        let response = vec![0x01, 0x01, 0x04, 0x02, 0x90, 0x00];
        let config = parse_app_configuration(&response).unwrap();
        assert_eq!(
            config,
            AppConfiguration {
                flags: 0x01,
                pub_key_display_mode: None,
                major: 0x01,
                minor: 0x04,
                patch: 0x02,
            },
        );
    }

    #[test]
    fn get_app_configuration_apdu_shape() {
        let apdu = build_get_app_configuration_apdu();
        assert_eq!(apdu, vec![CLA, INS_GET_APP_CONFIGURATION, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn wrap_offchain_message_ascii_path() {
        let msg = b"agentic sign-in nonce 12345";
        let wrapped = wrap_offchain_message(msg).unwrap();
        // Magic
        assert_eq!(&wrapped[..OFFCHAIN_MESSAGE_MAGIC.len()], OFFCHAIN_MESSAGE_MAGIC);
        // Version
        assert_eq!(wrapped[OFFCHAIN_MESSAGE_MAGIC.len()], OFFCHAIN_MESSAGE_VERSION);
        // Format: restricted ASCII for all-printable content
        assert_eq!(
            wrapped[OFFCHAIN_MESSAGE_MAGIC.len() + 1],
            OFFCHAIN_MESSAGE_FORMAT_RESTRICTED_ASCII
        );
        // Length: LE u16
        let len_offset = OFFCHAIN_MESSAGE_MAGIC.len() + 2;
        assert_eq!(
            u16::from_le_bytes([wrapped[len_offset], wrapped[len_offset + 1]]),
            msg.len() as u16
        );
        assert_eq!(&wrapped[len_offset + 2..], msg);
    }

    #[test]
    fn wrap_offchain_message_utf8_path_for_non_ascii() {
        let msg = "café".as_bytes();
        let wrapped = wrap_offchain_message(msg).unwrap();
        assert_eq!(
            wrapped[OFFCHAIN_MESSAGE_MAGIC.len() + 1],
            OFFCHAIN_MESSAGE_FORMAT_UTF8
        );
    }

    #[test]
    fn wrap_offchain_message_rejects_overlong() {
        let big = vec![b'a'; (u16::MAX as usize) + 1];
        let err = wrap_offchain_message(&big).unwrap_err();
        assert!(err.contains("exceeds"));
    }

    #[test]
    fn parse_app_configuration_extracts_five_byte_version() {
        let response = vec![0x01, 0x02, 0x01, 0x04, 0x02, 0x90, 0x00];
        let config = parse_app_configuration(&response).unwrap();
        assert_eq!(
            config,
            AppConfiguration {
                flags: 0x01,
                pub_key_display_mode: Some(0x02),
                major: 0x01,
                minor: 0x04,
                patch: 0x02,
            },
        );
    }

    #[test]
    fn build_sign_offchain_message_apdu_shape() {
        let path = encode_derivation_path(SOLANA_DEFAULT_PATH).unwrap();
        let env = wrap_offchain_message(b"hi").unwrap();
        let apdus = build_sign_offchain_message_apdu(&path, &env).unwrap();
        assert_eq!(apdus.len(), 1);
        let apdu = &apdus[0];
        assert_eq!(apdu[0], CLA);
        assert_eq!(apdu[1], INS_SIGN_OFFCHAIN_MESSAGE);
        assert_eq!(apdu[2], P1_CONFIRM);
        assert_eq!(apdu[3], 0x00);
        assert_eq!(apdu[4] as usize, 1 + path.len() + env.len());
        assert_eq!(apdu[5], 1);
        assert_eq!(&apdu[6..6 + path.len()], path.as_slice());
        assert_eq!(&apdu[6 + path.len()..], env.as_slice());
    }

    #[test]
    fn build_sign_offchain_message_apdu_chunks_overlong_payload() {
        let path = encode_derivation_path(SOLANA_DEFAULT_PATH).unwrap();
        let huge_env = vec![0xAAu8; 250];
        let apdus = build_sign_offchain_message_apdu(&path, &huge_env).unwrap();
        assert_eq!(apdus.len(), 2);
        assert_eq!(apdus[0][3], P2_MORE);
        assert_eq!(apdus[1][3], P2_EXTEND);
    }
}
