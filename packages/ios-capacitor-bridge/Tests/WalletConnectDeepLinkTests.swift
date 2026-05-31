import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class WalletConnectDeepLinkTests: XCTestCase {
    func testJupiterPairingLaunchUsesOnlyEncodedWalletConnectUri() throws {
        let pairing = "wc:abc123@2?relay-protocol=irn&symKey=secret"
        let candidates = AgenticWalletConnectDeepLink.pairingLaunchCandidates(uri: pairing, walletId: "jupiter")

        XCTAssertEqual(candidates.map(\.absoluteString), [
            "jupiter://wc?uri=wc%3Aabc123%402%3Frelay-protocol%3Dirn%26symKey%3Dsecret",
        ])
    }

    func testJupiterRequestLaunchUsesRequestAndSessionRoute() throws {
        let url = try XCTUnwrap(AgenticWalletConnectDeepLink.jupiterRequestLaunchUrl(
            requestId: "1780256123456789",
            sessionTopic: "abcdef1234567890"
        ))

        XCTAssertEqual(url.absoluteString, "jupiter://wc?requestId=1780256123456789&sessionTopic=abcdef1234567890")
        XCTAssertFalse(url.absoluteString.contains("uri="))
        XCTAssertFalse(url.absoluteString.contains("wc%3A"))
        XCTAssertFalse(url.absoluteString.contains("https://"))
        XCTAssertFalse(url.absoluteString.contains("jup.ag"))
    }

    func testNonJupiterPairingKeepsRawUriFallback() {
        let uri = "wc:raw@2?relay-protocol=irn"
        let candidates = AgenticWalletConnectDeepLink.pairingLaunchCandidates(uri: uri, walletId: "other")

        XCTAssertEqual(candidates.map(\.absoluteString), [uri])
    }
}
