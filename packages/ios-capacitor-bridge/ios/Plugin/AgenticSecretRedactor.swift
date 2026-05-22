// Swift port of apps/android-twa/.../agent/provider/SecretRedactor.kt.
// Patterns must stay in lockstep with the Kotlin source (Phase 7 fixture parity).
import Foundation

enum AgenticSecretRedactor {
    private static let bearerPattern = try! NSRegularExpression(
        pattern: #"Bearer\s+[A-Za-z0-9._~+/=-]+"#,
        options: [.caseInsensitive]
    )
    private static let skProjPattern = try! NSRegularExpression(
        pattern: #"\bsk-proj-[A-Za-z0-9_-]{8,}\b"#,
        options: []
    )
    private static let skPattern = try! NSRegularExpression(
        pattern: #"\bsk-[A-Za-z0-9_-]{8,}\b"#,
        options: []
    )
    private static let jwtPattern = try! NSRegularExpression(
        pattern: #"\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b"#,
        options: []
    )
    private static let keyValuePattern = try! NSRegularExpression(
        pattern: #"(api[-_ ]?key|token|secret)(["':=\s]+)([^"',\s\[]{8,})"#,
        options: [.caseInsensitive]
    )

    static func redact(_ value: String, secret: String? = nil) -> String {
        var current = value
        if let trimmed = secret?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
            current = current.replacingOccurrences(of: trimmed, with: "[redacted]")
        }
        current = replaceAll(current, regex: bearerPattern, with: "Bearer [redacted]")
        current = replaceAll(current, regex: skProjPattern, with: "sk-proj-[redacted]")
        current = replaceAll(current, regex: skPattern, with: "sk-[redacted]")
        current = replaceAll(current, regex: jwtPattern, with: "[redacted-token]")
        current = replaceKeyValue(current)
        return current
    }

    private static func replaceAll(_ input: String, regex: NSRegularExpression, with template: String) -> String {
        let range = NSRange(input.startIndex..., in: input)
        return regex.stringByReplacingMatches(in: input, options: [], range: range, withTemplate: template)
    }

    private static func replaceKeyValue(_ input: String) -> String {
        let range = NSRange(input.startIndex..., in: input)
        // Replace the third capture with `[redacted]`, keep groups 1 + 2 unchanged.
        return keyValuePattern.stringByReplacingMatches(
            in: input,
            options: [],
            range: range,
            withTemplate: "$1$2[redacted]"
        )
    }
}
