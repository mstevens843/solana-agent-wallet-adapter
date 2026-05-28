import Foundation

struct AgenticCitation: Equatable {
    let url: String
    let title: String?
    let citedText: String?

    init(url: String, title: String? = nil, citedText: String? = nil) {
        self.url = url
        self.title = title
        self.citedText = citedText
    }

    var json: [String: Any] {
        var out: [String: Any] = ["url": url]
        if let title { out["title"] = title }
        if let citedText { out["citedText"] = citedText }
        return out
    }
}

enum AgenticCitationFilter {
    private static let pricingPattern = try! NSRegularExpression(
        pattern: "\\b(price|cost|fee|rate|plan|plans|subscription|monthly|per[\\s-]?month)\\b|\\$\\s*\\d",
        options: [.caseInsensitive]
    )

    static func isPricingInstruction(_ text: String?) -> Bool {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return false
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return pricingPattern.firstMatch(in: text, options: [], range: range) != nil
    }

    static func filterLowAuthorityCitations(_ citations: [AgenticCitation], instructionText: String?) -> [AgenticCitation] {
        guard isPricingInstruction(instructionText) else { return citations }
        return citations.filter { !isLowAuthorityHost($0.url) }
    }

    private static func isLowAuthorityHost(_ rawUrl: String) -> Bool {
        guard !rawUrl.isEmpty,
              let components = URLComponents(string: rawUrl),
              let host = components.host?.lowercased(),
              !host.isEmpty else {
            return false
        }
        if host.hasPrefix("blog.") || host.hasPrefix("news.") { return true }
        if host.hasPrefix("community.") || host.hasPrefix("forum.") { return true }
        if host.hasSuffix(".blog") { return true }
        for suffix in ["medium.com", "substack.com", "wordpress.com", "tumblr.com"] {
            if host == suffix || host.hasSuffix(".\(suffix)") { return true }
        }
        return false
    }
}

enum AgenticProviderResponseParser {
    private static let citationCap = 8
    private static let citationWalkMaxDepth = 10

    static func extractOpenAiText(_ payload: [String: Any]) -> String {
        if let text = payload["output_text"] as? String, !text.isEmpty { return text }
        guard let choices = payload["choices"] as? [[String: Any]], let first = choices.first else { return "" }
        if let message = first["message"] as? [String: Any],
           let content = message["content"] as? String {
            return content
        }
        if let text = first["text"] as? String, !text.isEmpty { return text }
        return ""
    }

    static func extractAnthropicText(_ payload: [String: Any]) -> String {
        guard let content = payload["content"] as? [[String: Any]] else { return "" }
        return content.compactMap { $0["text"] as? String }.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    static func extractResponsesApiText(_ payload: [String: Any]) -> String {
        if let text = payload["output_text"] as? String, !text.isEmpty { return text }
        guard let output = payload["output"] as? [[String: Any]] else { return "" }
        var parts: [String] = []
        for entry in output {
            guard let content = entry["content"] as? [[String: Any]] else { continue }
            for piece in content {
                if let text = piece["text"] as? String, !text.isEmpty {
                    parts.append(text)
                }
            }
        }
        return parts.joined(separator: "\n")
    }

    static func extractGeminiText(_ payload: [String: Any]) -> String {
        guard let candidates = payload["candidates"] as? [[String: Any]],
              let first = candidates.first,
              let content = first["content"] as? [String: Any],
              let parts = content["parts"] as? [[String: Any]] else {
            return ""
        }
        return parts.compactMap { $0["text"] as? String }.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    static func extractAnthropicCitations(_ payload: [String: Any]) -> [AgenticCitation] {
        guard let content = payload["content"] as? [[String: Any]] else { return [] }
        var seen = Set<String>()
        var out: [AgenticCitation] = []
        for entry in content {
            guard let citations = entry["citations"] as? [[String: Any]] else { continue }
            for citation in citations {
                let url = (citation["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !url.isEmpty, !seen.contains(url) else { continue }
                seen.insert(url)
                let title = citation["title"] as? String
                let citedText = (citation["cited_text"] as? String) ?? (citation["citedText"] as? String)
                out.append(AgenticCitation(url: url, title: title, citedText: citedText))
            }
        }
        return out
    }

    static func extractResponsesApiCitations(_ payload: [String: Any]) -> [AgenticCitation] {
        var seen = Set<String>()
        var out: [AgenticCitation] = []
        walkForCitations(payload, depth: 0, seen: &seen, out: &out)
        return out
    }

    static func extractGeminiCitations(_ payload: [String: Any]) -> [AgenticCitation] {
        guard let candidates = payload["candidates"] as? [[String: Any]],
              let first = candidates.first,
              let grounding = first["groundingMetadata"] as? [String: Any],
              let chunks = grounding["groundingChunks"] as? [[String: Any]] else {
            return []
        }
        var seen = Set<String>()
        var out: [AgenticCitation] = []
        for chunk in chunks {
            if out.count >= citationCap { break }
            guard let web = chunk["web"] as? [String: Any] else { continue }
            let uri = (web["uri"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !uri.isEmpty, !seen.contains(uri) else { continue }
            seen.insert(uri)
            out.append(AgenticCitation(url: uri, title: web["title"] as? String))
        }
        return out
    }

    static func extractCitations(provider: String, raw: [String: Any]) -> [AgenticCitation] {
        switch provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "anthropic":
            return extractAnthropicCitations(raw)
        case "openai":
            return extractResponsesApiCitations(raw)
        case "gemini":
            return extractGeminiCitations(raw)
        default:
            return extractGenericUrlSources(raw)
        }
    }

    static func parseModelJson(_ text: String) -> [String: Any]? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        var candidates = [trimmed]
        candidates.append(contentsOf: codeFenceCandidates(trimmed))
        candidates.append(contentsOf: balancedJsonCandidates(trimmed))
        var seen = Set<String>()
        for candidate in candidates where !candidate.isEmpty && !seen.contains(candidate) {
            seen.insert(candidate)
            guard let data = candidate.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                continue
            }
            return parsed
        }
        return nil
    }

    private static func walkForCitations(_ value: Any?, depth: Int, seen: inout Set<String>, out: inout [AgenticCitation]) {
        if out.count >= citationCap || depth > citationWalkMaxDepth || value == nil { return }
        if let arr = value as? [Any] {
            for child in arr {
                if out.count >= citationCap { return }
                walkForCitations(child, depth: depth + 1, seen: &seen, out: &out)
            }
            return
        }
        guard let dict = value as? [String: Any] else { return }
        if let rawUrl = dict["url"] as? String {
            let url = rawUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            if !url.isEmpty, !seen.contains(url) {
                seen.insert(url)
                out.append(AgenticCitation(url: url, title: dict["title"] as? String))
            }
        }
        for child in dict.values {
            if out.count >= citationCap { return }
            walkForCitations(child, depth: depth + 1, seen: &seen, out: &out)
        }
    }

    private static func extractGenericUrlSources(_ raw: Any) -> [AgenticCitation] {
        var seen = Set<String>()
        var out: [AgenticCitation] = []
        walkForCitations(raw, depth: 0, seen: &seen, out: &out)
        return out
    }

    private static func codeFenceCandidates(_ text: String) -> [String] {
        var out: [String] = []
        var remainder = text[...]
        while let start = remainder.range(of: "```") {
            let afterFence = remainder[start.upperBound...]
            let contentStart = afterFence.hasPrefix("json") ? afterFence.index(afterFence.startIndex, offsetBy: 4) : afterFence.startIndex
            guard let end = afterFence[contentStart...].range(of: "```") else { break }
            out.append(String(afterFence[contentStart..<end.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines))
            remainder = afterFence[end.upperBound...]
        }
        return out
    }

    private static func balancedJsonCandidates(_ text: String) -> [String] {
        let chars = Array(text)
        var out: [String] = []
        var depth = 0
        var start = -1
        var inString = false
        var escape = false
        for (idx, ch) in chars.enumerated() {
            if escape {
                escape = false
                continue
            }
            if ch == "\\" && inString {
                escape = true
                continue
            }
            if ch == "\"" {
                inString.toggle()
                continue
            }
            if inString { continue }
            if ch == "{" {
                if depth == 0 { start = idx }
                depth += 1
            } else if ch == "}" && depth > 0 {
                depth -= 1
                if depth == 0 && start >= 0 {
                    out.append(String(chars[start...idx]))
                    start = -1
                }
            }
        }
        return out
    }
}
