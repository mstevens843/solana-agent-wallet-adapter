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

    func testJupiterRequestLaunchUsesIncompleteNativeRequestUri() throws {
        let url = try XCTUnwrap(AgenticWalletConnectDeepLink.jupiterRequestUrl(requestId: "1780256123456789"))

        XCTAssertEqual(url.absoluteString, "jupiter://wc?uri=wc%3A1780256123456789%402")
        XCTAssertFalse(url.absoluteString.contains("requestId="))
        XCTAssertFalse(url.absoluteString.contains("sessionTopic="))
        XCTAssertFalse(url.absoluteString.contains("https://"))
        XCTAssertFalse(url.absoluteString.contains("jup.ag"))
    }

    func testNonJupiterPairingKeepsRawUriFallback() {
        let uri = "wc:raw@2?relay-protocol=irn"
        let candidates = AgenticWalletConnectDeepLink.pairingLaunchCandidates(uri: uri, walletId: "other")

        XCTAssertEqual(candidates.map(\.absoluteString), [uri])
    }
}
