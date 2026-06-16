import Foundation

public struct AgenticWebViewRecoveryDecision: Equatable {
    public let shouldReload: Bool
    public let reason: String
}

public enum AgenticWebViewRecoveryPolicy {
    private static let walletHandoffHosts: Set<String> = [
        "backpack.app",
        "jup.ag",
        "jupiter.ag",
        "phantom.app",
        "solflare.com",
    ]

    public static func decision(
        liveUrl: String?,
        currentUrl: String?,
        walletRequestActive: Bool,
        liveHostReachable: Bool
    ) -> AgenticWebViewRecoveryDecision {
        guard let liveUrl,
              let live = URL(string: liveUrl),
              live.scheme?.lowercased() == "https",
              let liveHost = live.host?.lowercased(),
              !liveHost.isEmpty else {
            return .skip("no_live_url")
        }
        if walletRequestActive {
            return .skip("wallet_request_active")
        }
        if !liveHostReachable {
            return .skip("live_host_unreachable")
        }
        guard let currentUrl,
              let current = URL(string: currentUrl) else {
            return .reload("current_url_unavailable")
        }
        if origin(current) == origin(live) {
            return .skip("live_origin")
        }
        if isBundledLocal(current) {
            return .reload("bundled_fallback")
        }
        if isWalletHandoffHost(current) {
            return .skip("wallet_handoff_host")
        }
        if current.scheme?.lowercased() == "about" {
            return .reload("blank_page")
        }
        guard let currentHost = current.host?.lowercased(), !currentHost.isEmpty else {
            return .reload("current_host_unavailable")
        }
        if currentHost != liveHost {
            return .reload("unexpected_host")
        }
        return .reload("unexpected_origin")
    }

    private static func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased() else {
            return nil
        }
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    private static func isBundledLocal(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        let host = url.host?.lowercased()
        return (scheme == "capacitor" && host == "localhost") || host == "agentic.local"
    }

    private static func isWalletHandoffHost(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return walletHandoffHosts.contains { host == $0 || host.hasSuffix(".\($0)") }
    }
}

private extension AgenticWebViewRecoveryDecision {
    static func reload(_ reason: String) -> AgenticWebViewRecoveryDecision {
        AgenticWebViewRecoveryDecision(shouldReload: true, reason: reason)
    }

    static func skip(_ reason: String) -> AgenticWebViewRecoveryDecision {
        AgenticWebViewRecoveryDecision(shouldReload: false, reason: reason)
    }
}
