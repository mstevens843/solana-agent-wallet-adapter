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

    /// Foreground Jupiter for an in-flight signing request using the WalletConnect
    /// iOS "incomplete URI" trigger: `jupiter://wc?uri=wc:<sessionTopic>@2`.
    ///
    /// A WC sign request is NOT carried in a deep link — it travels over the relay
    /// to the already-paired wallet. This URL reuses Jupiter's working `wc?uri=`
    /// handler (the same path that pairs successfully) but carries only the session
    /// topic (no relay-protocol/symKey), which the WC mobile-linking spec defines as
    /// a foreground trigger: the wallet matches the topic to its active session and
    /// shows the pending request that already arrived over the relay. Crucially this
    /// routes into Jupiter's WC screen rather than bare `jupiter://`, which has no
    /// handler and falls through to Jupiter's web view (jup.ag).
    static func jupiterRequestForegroundUrl(sessionTopic: String) -> URL? {
        let incompleteUri = "wc:\(sessionTopic)@2"
        return URL(string: "jupiter://wc?uri=\(percentEncodeQueryValue(incompleteUri))")
    }

    private static func percentEncodeQueryValue(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
