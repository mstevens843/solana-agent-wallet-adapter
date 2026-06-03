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

    func testJupiterRequestForegroundUsesIncompleteUriTrigger() throws {
        // A WC sign request rides the relay, not a deep link. The dapp-side
        // foreground lever is the "incomplete URI" trigger jupiter://wc?uri=wc:<topic>@2
        // (session topic only) — it reuses Jupiter's working wc?uri= handler and
        // asks it to show the pending request, rather than bare jupiter:// (which
        // has no handler and falls through to Jupiter's web view at jup.ag).
        XCTAssertEqual(
            AgenticWalletConnectDeepLink.jupiterRequestForegroundUrl(sessionTopic: "abc123")?.absoluteString,
            "jupiter://wc?uri=wc%3Aabc123%402"
        )
    }

    func testJupiterRequestLaunchUsesBareSchemeFallback() throws {
        // Last-ditch fallback only (opens Jupiter's home/web view, not the request),
        // used only if the incomplete-URI trigger can't be built.
        XCTAssertEqual(AgenticWalletConnectDeepLink.jupiterRequestLaunchUrl()?.absoluteString, "jupiter://")
    }

    func testNonJupiterPairingKeepsRawUriFallback() {
        let uri = "wc:raw@2?relay-protocol=irn"
        let candidates = AgenticWalletConnectDeepLink.pairingLaunchCandidates(uri: uri, walletId: "other")

        XCTAssertEqual(candidates.map(\.absoluteString), [uri])
    }
}
