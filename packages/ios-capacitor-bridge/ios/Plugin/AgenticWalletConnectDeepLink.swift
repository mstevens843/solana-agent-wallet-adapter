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

    /// Foreground Jupiter for an in-flight signing request.
    ///
    /// A WC sign request is NOT carried in a deep link — it rides the relay to the
    /// already-paired wallet; we only need to bring Jupiter to the foreground so its
    /// WC client surfaces the pending request. We open Jupiter's bare custom scheme
    /// `jupiter://` — a warm/installed Jupiter opens the app (the jup.ag web
    /// fallthrough is a UNIVERSAL-link/cold-start behavior, NOT the custom scheme).
    ///
    /// The previous approach fabricated an "incomplete" pairing URI
    /// `jupiter://wc?uri=wc:<sessionTopic>@2`. reown-swift's `WalletConnectURI` parser
    /// requires `symKey` + `relay-protocol` and rejects that with "The format of the
    /// WalletConnect Pairing URI is invalid." — the exact error users saw. There is no
    /// valid pairing URI to synthesize for an ALREADY-established session, so we don't
    /// try; foregrounding the app is sufficient for the relay request to surface.
    static func jupiterRequestForegroundUrl(sessionTopic _: String) -> URL? {
        return URL(string: "jupiter://")
    }

    private static func percentEncodeQueryValue(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
