import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class Keccak256Tests: XCTestCase {
    func testKnownVectors() {
        XCTAssertEqual(
            AgenticKeccak256.hash(Data()).hexString,
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        )
        XCTAssertEqual(
            AgenticKeccak256.hash(Data("abc".utf8)).hexString,
            "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        )
    }
}

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
