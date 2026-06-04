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
        // asks it to show the pending request. This is now the SOLE sign-launch
        // candidate: bare jupiter:// was removed because it has no request handler
        // and falls through to Jupiter's web view at jup.ag (the "dumped on a
        // website" failure). If iOS refuses this trigger, the in-app "Open Jupiter
        // again" button is the recovery — never a jup.ag bounce.
        XCTAssertEqual(
            AgenticWalletConnectDeepLink.jupiterRequestForegroundUrl(sessionTopic: "abc123")?.absoluteString,
            "jupiter://wc?uri=wc%3Aabc123%402"
        )
    }

    func testNonJupiterPairingKeepsRawUriFallback() {
        let uri = "wc:raw@2?relay-protocol=irn"
        let candidates = AgenticWalletConnectDeepLink.pairingLaunchCandidates(uri: uri, walletId: "other")

        XCTAssertEqual(candidates.map(\.absoluteString), [uri])
    }
}
