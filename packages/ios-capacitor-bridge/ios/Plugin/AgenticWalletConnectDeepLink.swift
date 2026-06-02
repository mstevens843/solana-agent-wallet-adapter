import Foundation

enum AgenticWalletConnectDeepLink {
    static func pairingLaunchCandidates(uri: String, walletId: String) -> [URL] {
        if walletId.lowercased() == "jupiter" {
            guard let url = jupiterPairingUrl(uri: uri) else { return [] }
            return [url]
        }
        guard let url = URL(string: uri) else { return [] }
        return [url]
    }

    static func jupiterPairingUrl(uri: String) -> URL? {
        URL(string: "jupiter://wc?uri=\(percentEncodeQueryValue(uri))")
    }

    /// Fallback URL to foreground Jupiter for an in-flight signing request when
    /// the session's peer redirect is unavailable. The request itself is already
    /// delivered over the WalletConnect relay; opening Jupiter just surfaces its
    /// pending-request sheet. Bare `jupiter://` (no `wc?uri=`) because, unlike
    /// pairing, a request carries no URI to hand over.
    static func jupiterRequestLaunchUrl() -> URL? {
        URL(string: "jupiter://")
    }

    private static func percentEncodeQueryValue(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
