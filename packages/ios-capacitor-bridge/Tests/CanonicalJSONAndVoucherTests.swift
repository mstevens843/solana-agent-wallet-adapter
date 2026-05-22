// Cross-platform parity: same voucher + seed should produce identical
// canonical-JSON, SHA-256 digest, and Ed25519 signature on iOS as on the
// Node-generated fixture. Catches drift in CanonicalJSON ordering / Ed25519
// implementation.
import CryptoKit
import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class CanonicalJSONAndVoucherTests: XCTestCase {
    func testCanonicalEncoderSortsKeys() throws {
        let input: [String: Any] = ["z": 1, "a": 2, "m": ["b": true, "a": false]]
        let encoded = String(data: try AgenticCanonicalJSON.encode(input), encoding: .utf8)!
        XCTAssertEqual(encoded, "{\"a\":2,\"m\":{\"a\":false,\"b\":true},\"z\":1}")
    }

    func testEmptyTypes() throws {
        XCTAssertEqual(String(data: try AgenticCanonicalJSON.encode([:] as [String: Any]), encoding: .utf8)!, "{}")
        XCTAssertEqual(String(data: try AgenticCanonicalJSON.encode([] as [Any]), encoding: .utf8)!, "[]")
        XCTAssertEqual(String(data: try AgenticCanonicalJSON.encode(NSNull()), encoding: .utf8)!, "null")
        XCTAssertEqual(String(data: try AgenticCanonicalJSON.encode(true), encoding: .utf8)!, "true")
    }

    func testVoucherFixtureParity() throws {
        let json = try XCTUnwrap(FixtureLoader.loadJson("voucher-fixtures") as? [String: Any])
        let seedHex = json["seedHex"] as! String
        let vouchers = json["vouchers"] as! [[String: Any]]

        let seed = Data(hexString: seedHex)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)

        for v in vouchers {
            let name = v["name"] as? String ?? "?"
            let voucher = v["voucher"] as! [String: Any]
            let expectedCanonical = v["canonicalJson"] as! String
            let expectedSha = v["sha256Hex"] as! String
            let expectedSig = v["ed25519SignatureHex"] as! String

            // Canonical JSON parity.
            let canonical = try AgenticCanonicalJSON.encode(voucher)
            let canonicalString = String(data: canonical, encoding: .utf8)!
            XCTAssertEqual(canonicalString, expectedCanonical, "canonical JSON mismatch for \(name)")

            // SHA-256 parity.
            let sha = SHA256.hash(data: canonical)
            let shaHex = sha.map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(shaHex, expectedSha, "SHA-256 mismatch for \(name)")

            // Ed25519 sign-the-digest parity (matches the iOS streaming controller
            // which signs the SHA-256 digest, not the canonical JSON directly).
            let sig = try key.signature(for: Data(sha))
            let sigHex = sig.map { String(format: "%02x", $0) }.joined()
            // Note: the Node fixture also signs the SHA-256 digest, so this
            // parity is end-to-end-identical.
            XCTAssertEqual(sigHex, expectedSig, "Ed25519 signature mismatch for \(name)")
        }
    }

    func testMemoEnvelopeFixture() throws {
        let json = try XCTUnwrap(FixtureLoader.loadJson("memo-router-cases") as? [String: Any])
        let envelope = json["envelope"] as! [String: Any]
        let prefix = envelope["prefix"] as! String
        XCTAssertEqual(prefix, "Agentic plan review proof v1\nSHA-256: ", "memo envelope prefix drifted")
        let cases = envelope["cases"] as! [[String: Any]]
        for c in cases {
            let msg = c["message"] as! String
            let expectedSha = c["sha256Hex"] as! String
            let expectedEnvelope = c["envelope"] as! String
            let sha = SHA256.hash(data: Data(msg.utf8))
            let shaHex = sha.map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(shaHex, expectedSha, "SHA-256 mismatch for memo message: \(msg)")
            XCTAssertEqual(prefix + shaHex, expectedEnvelope, "envelope assembly mismatch for: \(msg)")
        }
    }
}

private extension Data {
    init(hexString: String) {
        self.init()
        let chars = Array(hexString)
        var i = 0
        while i + 1 < chars.count {
            if let byte = UInt8(String(chars[i...i + 1]), radix: 16) {
                self.append(byte)
            }
            i += 2
        }
    }
}
