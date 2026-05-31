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

    static func jupiterRequestLaunchUrl(requestId: String, sessionTopic: String) -> URL? {
        var components = URLComponents()
        components.scheme = "jupiter"
        components.host = "wc"
        components.queryItems = [
            URLQueryItem(name: "requestId", value: requestId),
            URLQueryItem(name: "sessionTopic", value: sessionTopic),
        ]
        return components.url
    }

    private static func percentEncodeQueryValue(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
