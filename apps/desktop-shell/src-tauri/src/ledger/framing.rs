// Ledger HID packet framing (Slice G).
//
// Layered on top of a raw 64-byte HID transport. Each command (an APDU
// blob) is split into one or more 64-byte HID packets:
//
//   First packet:
//     [channel_id u16 BE][tag=0x05][seq=0x0000 u16 BE][apdu_total_len u16 BE][apdu_bytes…]
//        2 bytes           1 byte      2 bytes              2 bytes              57 bytes
//
//   Subsequent packet:
//     [channel_id u16 BE][tag=0x05][seq=N u16 BE][apdu_bytes…]
//        2 bytes           1 byte      2 bytes        59 bytes
//
// Response framing mirrors the request side. The channel id is randomized
// per command (any non-zero value works) and exists to detect crossed
// sequences if multiple consumers shared a device — we don't, but we
// follow the protocol faithfully so a future shared transport works.
//
// This module is pure: it takes an injectable `HidTransport` so tests use
// a deterministic mock. The real hidapi implementation lives in
// `transport.rs`.

pub const PACKET_LEN: usize = 64;
const TAG_APDU: u8 = 0x05;

/// Maximum response APDU we'll accept from a Ledger. The Solana app's
/// largest legitimate response is a 64-byte signature plus a 2-byte status
/// word — nowhere near this cap. The bound exists to defang a malicious or
/// wedged peer that declares a near-`u16::MAX` total length in the first
/// packet, which would otherwise force `read_apdu` to wait through ~1100
/// per-packet timeouts before giving up. 8 KiB leaves plenty of headroom
/// for firmware app-listing responses while staying obviously distinct
/// from an attack-shaped value.
const MAX_RESPONSE_LEN: usize = 8_192;
// Per-packet payload room is derived inline below: 57 bytes for the first
// packet (header is 7 bytes) and 59 bytes for subsequent packets (header
// is 5 bytes). Keeping the constants inlined avoids drift if the header
// shape changes.

/// Abstract HID transport. Tests pass a fake; production wires a real
/// `hidapi::HidDevice`.
pub trait HidTransport {
    fn write_packet(&mut self, packet: &[u8; PACKET_LEN]) -> Result<(), String>;
    fn read_packet(&mut self, timeout_ms: u32) -> Result<[u8; PACKET_LEN], String>;
}

/// Send an APDU + receive its response, fragmenting/reassembling across
/// 64-byte HID packets per Ledger's framing.
pub fn exchange_apdu<T: HidTransport>(
    transport: &mut T,
    channel_id: u16,
    apdu: &[u8],
    read_timeout_ms: u32,
) -> Result<Vec<u8>, String> {
    write_apdu(transport, channel_id, apdu)?;
    read_apdu(transport, channel_id, read_timeout_ms)
}

pub fn write_apdu<T: HidTransport>(
    transport: &mut T,
    channel_id: u16,
    apdu: &[u8],
) -> Result<(), String> {
    if apdu.is_empty() {
        // The framing would emit a single seq=0 packet with total=0 and no
        // payload — devices interpret this as a malformed APDU. Reject up
        // front so the failure surfaces in our layer with a clear message
        // instead of a cryptic device error.
        return Err("APDU cannot be empty".into());
    }
    if apdu.len() > u16::MAX as usize {
        return Err(format!(
            "APDU length {} exceeds u16 max ({}) bytes",
            apdu.len(),
            u16::MAX
        ));
    }
    let mut offset = 0usize;
    let mut seq: u16 = 0;
    while offset == 0 || offset < apdu.len() {
        let mut packet = [0u8; PACKET_LEN];
        packet[0..2].copy_from_slice(&channel_id.to_be_bytes());
        packet[2] = TAG_APDU;
        packet[3..5].copy_from_slice(&seq.to_be_bytes());
        let payload_offset = if seq == 0 {
            packet[5..7].copy_from_slice(&(apdu.len() as u16).to_be_bytes());
            7
        } else {
            5
        };
        let payload_room = PACKET_LEN - payload_offset;
        let take = std::cmp::min(payload_room, apdu.len() - offset);
        if take > 0 {
            packet[payload_offset..payload_offset + take]
                .copy_from_slice(&apdu[offset..offset + take]);
        }
        transport.write_packet(&packet)?;
        offset += take;
        if seq == u16::MAX {
            return Err("APDU sequence overflow".into());
        }
        seq = seq.checked_add(1).ok_or("sequence overflow")?;
        if offset >= apdu.len() {
            break;
        }
    }
    Ok(())
}

pub fn read_apdu<T: HidTransport>(
    transport: &mut T,
    channel_id: u16,
    timeout_ms: u32,
) -> Result<Vec<u8>, String> {
    let mut expected_seq: u16 = 0;
    let mut total_len: Option<usize> = None;
    let mut out: Vec<u8> = Vec::new();

    loop {
        let packet = transport.read_packet(timeout_ms)?;
        let pkt_channel = u16::from_be_bytes([packet[0], packet[1]]);
        if pkt_channel != channel_id {
            return Err(format!(
                "ledger framing: unexpected channel id {pkt_channel:#06x} (expected {channel_id:#06x})"
            ));
        }
        if packet[2] != TAG_APDU {
            return Err(format!("ledger framing: unexpected tag {:#04x}", packet[2]));
        }
        let pkt_seq = u16::from_be_bytes([packet[3], packet[4]]);
        if pkt_seq != expected_seq {
            return Err(format!(
                "ledger framing: out-of-order sequence {pkt_seq} (expected {expected_seq})"
            ));
        }
        let payload_offset = if pkt_seq == 0 {
            let len = u16::from_be_bytes([packet[5], packet[6]]) as usize;
            if len > MAX_RESPONSE_LEN {
                return Err(format!(
                    "ledger framing: response length {len} exceeds cap {MAX_RESPONSE_LEN}"
                ));
            }
            total_len = Some(len);
            7
        } else {
            5
        };
        let total = total_len.ok_or_else(|| {
            "ledger framing: first response packet missing total length (seq != 0 on initial packet)"
                .to_string()
        })?;
        let remaining = total.saturating_sub(out.len());
        let payload_avail = PACKET_LEN - payload_offset;
        let take = std::cmp::min(remaining, payload_avail);
        if take > 0 {
            out.extend_from_slice(&packet[payload_offset..payload_offset + take]);
        }
        if out.len() >= total {
            return Ok(out);
        }
        expected_seq = expected_seq.checked_add(1).ok_or("sequence overflow")?;
    }
}

#[cfg(test)]
pub mod tests_support {
    use std::collections::VecDeque;

    use super::*;

    pub struct MockTransport {
        pub writes: Vec<[u8; PACKET_LEN]>,
        pub responses: VecDeque<[u8; PACKET_LEN]>,
        pub timeout_calls: Vec<u32>,
    }

    impl Default for MockTransport {
        fn default() -> Self {
            Self::new()
        }
    }

    impl MockTransport {
        pub fn new() -> Self {
            Self {
                writes: Vec::new(),
                responses: VecDeque::new(),
                timeout_calls: Vec::new(),
            }
        }

        pub fn enqueue_response(&mut self, packet: [u8; PACKET_LEN]) {
            self.responses.push_back(packet);
        }

        /// Enqueue an APDU response framed as Ledger HID packets. Used by
        /// tests to script realistic round-trips.
        pub fn enqueue_apdu_response(&mut self, channel_id: u16, response: &[u8]) {
            let mut offset = 0usize;
            let mut seq: u16 = 0;
            while offset == 0 || offset < response.len() {
                let mut packet = [0u8; PACKET_LEN];
                packet[0..2].copy_from_slice(&channel_id.to_be_bytes());
                packet[2] = TAG_APDU;
                packet[3..5].copy_from_slice(&seq.to_be_bytes());
                let payload_offset = if seq == 0 {
                    packet[5..7].copy_from_slice(&(response.len() as u16).to_be_bytes());
                    7
                } else {
                    5
                };
                let payload_room = PACKET_LEN - payload_offset;
                let take = std::cmp::min(payload_room, response.len() - offset);
                if take > 0 {
                    packet[payload_offset..payload_offset + take]
                        .copy_from_slice(&response[offset..offset + take]);
                }
                self.enqueue_response(packet);
                offset += take;
                seq = seq.checked_add(1).expect("seq overflow in mock");
                if offset >= response.len() {
                    break;
                }
            }
        }
    }

    impl HidTransport for MockTransport {
        fn write_packet(&mut self, packet: &[u8; PACKET_LEN]) -> Result<(), String> {
            self.writes.push(*packet);
            Ok(())
        }

        fn read_packet(&mut self, timeout_ms: u32) -> Result<[u8; PACKET_LEN], String> {
            self.timeout_calls.push(timeout_ms);
            self.responses
                .pop_front()
                .ok_or_else(|| "MockTransport: no more responses queued".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::MockTransport;
    use super::*;

    #[test]
    fn single_packet_apdu_roundtrip() {
        let mut transport = MockTransport::new();
        let response = vec![0x12, 0x34, 0x90, 0x00];
        transport.enqueue_apdu_response(0xABCD, &response);

        let apdu = vec![0xE0, 0x05, 0x00, 0x00, 0x04, 0x01, 0x02, 0x03, 0x04];
        let resp = exchange_apdu(&mut transport, 0xABCD, &apdu, 500).unwrap();
        assert_eq!(resp, response);

        // One write packet with the right header + payload.
        assert_eq!(transport.writes.len(), 1);
        let pkt = transport.writes[0];
        assert_eq!(u16::from_be_bytes([pkt[0], pkt[1]]), 0xABCD);
        assert_eq!(pkt[2], TAG_APDU);
        assert_eq!(u16::from_be_bytes([pkt[3], pkt[4]]), 0);
        assert_eq!(u16::from_be_bytes([pkt[5], pkt[6]]), apdu.len() as u16);
        assert_eq!(&pkt[7..7 + apdu.len()], apdu.as_slice());
    }

    #[test]
    fn multi_packet_apdu_send_and_receive() {
        let mut transport = MockTransport::new();
        // A response large enough to span two packets (>57 bytes).
        let response: Vec<u8> = (0..120u8).chain([0x90, 0x00]).collect();
        transport.enqueue_apdu_response(0x1234, &response);

        // Likewise build a request that needs 3 packets.
        let apdu: Vec<u8> = (0..150u8).collect();
        let result = exchange_apdu(&mut transport, 0x1234, &apdu, 500).unwrap();
        assert_eq!(result, response);

        // Expect ceil(150 / 57 first + 59 subsequent) packets = 3.
        assert_eq!(transport.writes.len(), 3);
        // All writes use channel 0x1234 and tag 0x05.
        for (idx, pkt) in transport.writes.iter().enumerate() {
            assert_eq!(u16::from_be_bytes([pkt[0], pkt[1]]), 0x1234);
            assert_eq!(pkt[2], TAG_APDU);
            assert_eq!(u16::from_be_bytes([pkt[3], pkt[4]]), idx as u16);
        }
    }

    #[test]
    fn read_rejects_mismatched_channel() {
        let mut transport = MockTransport::new();
        // Response framed against wrong channel.
        transport.enqueue_apdu_response(0xFFFF, &[0x90, 0x00]);
        let apdu = vec![0xE0, 0x05, 0x00, 0x00, 0x00];
        let err = exchange_apdu(&mut transport, 0xABCD, &apdu, 500).unwrap_err();
        assert!(err.contains("unexpected channel id"));
    }

    #[test]
    fn read_rejects_wrong_tag() {
        let mut transport = MockTransport::new();
        let mut packet = [0u8; PACKET_LEN];
        packet[0..2].copy_from_slice(&0xABCDu16.to_be_bytes());
        packet[2] = 0x06; // not 0x05
        packet[5..7].copy_from_slice(&2u16.to_be_bytes());
        packet[7] = 0x90;
        packet[8] = 0x00;
        transport.enqueue_response(packet);
        let apdu = vec![0xE0, 0x05, 0x00, 0x00, 0x00];
        let err = exchange_apdu(&mut transport, 0xABCD, &apdu, 500).unwrap_err();
        assert!(err.contains("unexpected tag"));
    }

    #[test]
    fn read_rejects_out_of_order_sequence() {
        let mut transport = MockTransport::new();
        // First packet announces a 100-byte response but uses seq=0 — fine.
        // Second packet then arrives with seq=2 instead of 1 — error.
        let response: Vec<u8> = (0..120u8).chain([0x90, 0x00]).collect();
        let mut first = [0u8; PACKET_LEN];
        first[0..2].copy_from_slice(&0xABCDu16.to_be_bytes());
        first[2] = TAG_APDU;
        // seq=0
        first[5..7].copy_from_slice(&(response.len() as u16).to_be_bytes());
        first[7..7 + 57].copy_from_slice(&response[..57]);
        transport.enqueue_response(first);
        // second packet with bogus seq=2
        let mut second = [0u8; PACKET_LEN];
        second[0..2].copy_from_slice(&0xABCDu16.to_be_bytes());
        second[2] = TAG_APDU;
        second[3..5].copy_from_slice(&2u16.to_be_bytes());
        second[5..5 + 50].copy_from_slice(&response[57..107]);
        transport.enqueue_response(second);
        let apdu = vec![0xE0, 0x05, 0x00, 0x00, 0x00];
        let err = exchange_apdu(&mut transport, 0xABCD, &apdu, 500).unwrap_err();
        assert!(err.contains("out-of-order"));
    }

    #[test]
    fn read_rejects_non_zero_seq_first_packet() {
        // A malicious / faulty peer sends a packet labeled seq=1 as the first
        // response. The reader must return Err, not panic.
        let mut transport = MockTransport::new();
        let mut packet = [0u8; PACKET_LEN];
        packet[0..2].copy_from_slice(&0xABCDu16.to_be_bytes());
        packet[2] = TAG_APDU;
        packet[3..5].copy_from_slice(&1u16.to_be_bytes()); // seq=1 — illegal as first packet
        transport.enqueue_response(packet);
        let apdu = vec![0xE0, 0x05, 0x00, 0x00, 0x00];
        let err = exchange_apdu(&mut transport, 0xABCD, &apdu, 500).unwrap_err();
        // The out-of-order sequence check fires before the missing-total
        // check, but either error is acceptable as long as it's not a panic.
        assert!(err.contains("out-of-order") || err.contains("missing total length"));
    }

    #[test]
    fn write_rejects_overlong_apdu() {
        let mut transport = MockTransport::new();
        let huge = vec![0u8; (u16::MAX as usize) + 1];
        let err = write_apdu(&mut transport, 0x0001, &huge).unwrap_err();
        assert!(err.contains("exceeds"));
    }

    #[test]
    fn write_rejects_empty_apdu() {
        let mut transport = MockTransport::new();
        let err = write_apdu(&mut transport, 0x0001, &[]).unwrap_err();
        assert!(err.contains("empty"));
        // No bytes leak through to the device.
        assert!(transport.writes.is_empty());
    }

    #[test]
    fn read_rejects_response_length_above_cap() {
        // First packet declares a payload total > MAX_RESPONSE_LEN. The
        // reader must bail before allocating buffers or reading further
        // packets.
        let mut transport = MockTransport::new();
        let mut packet = [0u8; PACKET_LEN];
        packet[0..2].copy_from_slice(&0xABCDu16.to_be_bytes());
        packet[2] = TAG_APDU;
        // total length = MAX_RESPONSE_LEN + 1, but we encode in u16 (max
        // 65535) — bump just past the cap. We can fit 65_535 in the field.
        let declared: u16 = u16::MAX;
        packet[5..7].copy_from_slice(&declared.to_be_bytes());
        transport.enqueue_response(packet);
        let apdu = vec![0xE0, 0x05, 0x00, 0x00, 0x00, 0x01];
        let err = exchange_apdu(&mut transport, 0xABCD, &apdu, 500).unwrap_err();
        assert!(err.contains("exceeds cap"), "got {err}");
    }
}
