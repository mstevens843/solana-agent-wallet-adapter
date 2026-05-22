import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class Base58Tests: XCTestCase {
    func testEncodeDecodeFixtureVectors() throws {
        let json = try FixtureLoader.loadJson("base58-vectors") as? [[String: String]]
        let vectors = try XCTUnwrap(json)
        for vec in vectors {
            let hex = vec["hex"]!
            let expected = vec["base58"]!
            let data = Data(hexString: hex)
            XCTAssertEqual(AgenticBase58.encode(data), expected, "encode mismatch for hex=\(hex)")
            let decoded = try AgenticBase58.decode(expected)
            XCTAssertEqual(decoded.hexString, hex, "decode mismatch for base58=\(expected)")
        }
    }

    func testEmptyRoundTrip() throws {
        XCTAssertEqual(AgenticBase58.encode(Data()), "")
        XCTAssertEqual(try AgenticBase58.decode("").count, 0)
    }

    func testRejectsInvalidCharacter() {
        XCTAssertThrowsError(try AgenticBase58.decode("0OIl"))
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

    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
