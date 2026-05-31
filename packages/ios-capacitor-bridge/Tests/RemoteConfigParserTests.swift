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

    func testWalletConnectFieldsUseServerValues() throws {
        let config = try parse("""
        {
          "version": 1,
          "walletRegistry": [{ "id": "jupiter", "name": "Jupiter" }],
          "memoProofRouter": { "envelopeVersion": "v1" },
          "walletConnectProjectId": "7c5434a4b0dffb44ae4344c1da2f9825",
          "walletConnectRelayHost": "relay.walletconnect.com",
          "walletConnectRelayOrigin": "https://agentic-signer.com",
          "walletConnectRedirectNative": "agenticwallet://callback/walletconnect?phase=walletconnect",
          "walletConnectRedirectUniversal": "https://agentic-signer.com/ios/callback/walletconnect"
        }
        """)

        XCTAssertEqual(config.walletConnectProjectId, "7c5434a4b0dffb44ae4344c1da2f9825")
        XCTAssertEqual(config.walletConnectRelayHost, "relay.walletconnect.com")
        XCTAssertEqual(config.walletConnectRelayOrigin, "https://agentic-signer.com")
        XCTAssertEqual(config.walletConnectRedirectNative, "agenticwallet://callback/walletconnect?phase=walletconnect")
        XCTAssertEqual(config.walletConnectRedirectUniversal, "https://agentic-signer.com/ios/callback/walletconnect")
    }

    func testWalletConnectFieldsFallbackWhenOmitted() throws {
        let config = try parse("""
        {
          "version": 1,
          "walletRegistry": [{ "id": "jupiter", "name": "Jupiter" }],
          "memoProofRouter": { "envelopeVersion": "v1" }
        }
        """)

        XCTAssertEqual(config.walletConnectRelayHost, AgenticRemoteConfigDefaults.bundled.walletConnectRelayHost)
        XCTAssertEqual(config.walletConnectRelayOrigin, AgenticRemoteConfigDefaults.bundled.walletConnectRelayOrigin)
        XCTAssertEqual(config.walletConnectRedirectNative, AgenticRemoteConfigDefaults.bundled.walletConnectRedirectNative)
        XCTAssertEqual(config.walletConnectRedirectUniversal, AgenticRemoteConfigDefaults.bundled.walletConnectRedirectUniversal)
    }

    private func parse(_ text: String) throws -> AgenticMobileConfig {
        let data = try XCTUnwrap(text.data(using: .utf8))
        return try AgenticRemoteConfigParser.parseV1(data)
    }
}
