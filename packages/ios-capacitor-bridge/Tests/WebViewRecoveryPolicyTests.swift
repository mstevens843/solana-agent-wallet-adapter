import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class WebViewRecoveryPolicyTests: XCTestCase {
    private let liveUrl = "https://agentic-signer.com"

    func testSkipsWhenAlreadyOnLiveOrigin() {
        let decision = AgenticWebViewRecoveryPolicy.decision(
            liveUrl: liveUrl,
            currentUrl: "https://agentic-signer.com/app",
            walletRequestActive: false,
            liveHostReachable: true
        )

        XCTAssertFalse(decision.shouldReload)
        XCTAssertEqual(decision.reason, "live_origin")
    }

    func testReloadsBundledFallbackWhenLiveHostReachable() {
        let decision = AgenticWebViewRecoveryPolicy.decision(
            liveUrl: liveUrl,
            currentUrl: "capacitor://localhost/app",
            walletRequestActive: false,
            liveHostReachable: true
        )

        XCTAssertTrue(decision.shouldReload)
        XCTAssertEqual(decision.reason, "bundled_fallback")
    }

    func testReloadsWhenCurrentUrlIsUnavailable() {
        let decision = AgenticWebViewRecoveryPolicy.decision(
            liveUrl: liveUrl,
            currentUrl: nil,
            walletRequestActive: false,
            liveHostReachable: true
        )

        XCTAssertTrue(decision.shouldReload)
        XCTAssertEqual(decision.reason, "current_url_unavailable")
    }

    func testSkipsWhenLiveUrlIsNotHttps() {
        let decision = AgenticWebViewRecoveryPolicy.decision(
            liveUrl: "capacitor://localhost",
            currentUrl: "capacitor://localhost/app",
            walletRequestActive: false,
            liveHostReachable: true
        )

        XCTAssertFalse(decision.shouldReload)
        XCTAssertEqual(decision.reason, "no_live_url")
    }

    func testSkipsBundledFallbackDuringWalletRequest() {
        let decision = AgenticWebViewRecoveryPolicy.decision(
            liveUrl: liveUrl,
            currentUrl: "capacitor://localhost/app",
            walletRequestActive: true,
            liveHostReachable: true
        )

        XCTAssertFalse(decision.shouldReload)
        XCTAssertEqual(decision.reason, "wallet_request_active")
    }

    func testSkipsBundledFallbackWhenLiveHostUnreachable() {
        let decision = AgenticWebViewRecoveryPolicy.decision(
            liveUrl: liveUrl,
            currentUrl: "capacitor://localhost/app",
            walletRequestActive: false,
            liveHostReachable: false
        )

        XCTAssertFalse(decision.shouldReload)
        XCTAssertEqual(decision.reason, "live_host_unreachable")
    }

    func testReloadsUnexpectedNonWalletHost() {
        let decision = AgenticWebViewRecoveryPolicy.decision(
            liveUrl: liveUrl,
            currentUrl: "https://example.com/app",
            walletRequestActive: false,
            liveHostReachable: true
        )

        XCTAssertTrue(decision.shouldReload)
        XCTAssertEqual(decision.reason, "unexpected_host")
    }

    func testSkipsKnownWalletHandoffHosts() {
        let decision = AgenticWebViewRecoveryPolicy.decision(
            liveUrl: liveUrl,
            currentUrl: "https://backpack.app/ul/v1/connect",
            walletRequestActive: false,
            liveHostReachable: true
        )

        XCTAssertFalse(decision.shouldReload)
        XCTAssertEqual(decision.reason, "wallet_handoff_host")
    }
}
