import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class RemoteConfigParserTests: XCTestCase {
    func testFallsBackToBundledWalletsWhenFlatRegistryParsesEmpty() throws {
        let config = try parse("""
        {
          "version": 1,
          "walletRegistry": [{ "id": "broken" }],
          "memoProofRouter": { "envelopeVersion": "v1" }
        }
        """)
        XCTAssertEqual(config.walletRegistry, AgenticRemoteConfigDefaults.bundled.walletRegistry)
    }

    func testFallsBackToBundledWalletsWhenIosRegistryParsesEmpty() throws {
        let config = try parse("""
        {
          "version": 1,
          "walletRegistry": { "ios": [{ "name": "Missing id" }] },
          "memoProofRouter": { "envelopeVersion": "v1" }
        }
        """)
        XCTAssertEqual(config.walletRegistry, AgenticRemoteConfigDefaults.bundled.walletRegistry)
    }

    func testBlankMemoPrefixFallsBackToDefault() throws {
        let config = try parse("""
        {
          "version": 1,
          "walletRegistry": [{ "id": "phantom", "name": "Phantom" }],
          "memoProofRouter": {
            "envelopeVersion": "v1",
            "proofMemoPrefix": "   ",
            "fallbackOnBlankPackage": false
          }
        }
        """)
        XCTAssertEqual(config.memoProofRouter.proofMemoPrefix, AgenticRemoteConfigDefaults.memoEnvelopePrefix)
        XCTAssertFalse(config.memoProofRouter.fallbackOnBlankPackage)
    }

    private func parse(_ text: String) throws -> AgenticMobileConfig {
        let data = try XCTUnwrap(text.data(using: .utf8))
        return try AgenticRemoteConfigParser.parseV1(data)
    }
}
