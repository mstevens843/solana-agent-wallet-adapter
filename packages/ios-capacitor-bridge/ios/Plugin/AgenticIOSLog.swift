import Foundation

enum AgenticIOSLog {
    /// When true, sensitive values (payloads, signatures, transactions, …) are
    /// logged in full instead of `[redacted]`, for a local debug session.
    /// Defaults on only in DEBUG builds so Release never leaks raw artifacts to
    /// the device syslog. Flip at runtime via `setRawValues(_:)` (e.g. the JS
    /// layer enables it when logLevel === 'debug').
    #if DEBUG
    private static var allowRawValues = true
    #else
    private static var allowRawValues = false
    #endif

    private static let rawValueCap = 3000
    private static let redactedValueCap = 240

    static func setRawValues(_ enabled: Bool) {
        allowRawValues = enabled
    }

    static func info(
        _ component: String,
        _ method: String,
        _ step: String,
        _ message: String,
        _ metadata: [String: String] = [:]
    ) {
        write(component, method, step, "INFO", message, metadata)
    }

    static func fail(
        _ component: String,
        _ method: String,
        _ step: String,
        _ message: String,
        _ metadata: [String: String] = [:]
    ) {
        write(component, method, step, "FAIL", message, metadata)
    }

    private static func write(
        _ component: String,
        _ method: String,
        _ step: String,
        _ phase: String,
        _ message: String,
        _ metadata: [String: String]
    ) {
        let suffix = metadata
            .sorted { $0.key < $1.key }
            .map { "\(sanitizeKey($0.key))=\(quote(sanitizeValue(key: $0.key, value: $0.value)))" }
            .joined(separator: " ")
        let line = "[AgentIOSApp] [\(component)] \(method) | \(step) phase=\(phase) message=\(quote(message))"
        let finalLine = suffix.isEmpty ? line : "\(line) \(suffix)"
        // NSLog (not print) so the line reaches the device unified log / syslog —
        // visible in `idevicesyslog`, Console.app, AND the Xcode console. print()
        // only reaches stdout, which is captured solely by an attached Xcode
        // debugger. Use an explicit "%@" format: `finalLine` contains user data
        // with possible `%` characters that must not be interpreted as a format.
        NSLog("%@", finalLine)
    }

    private static func sanitizeKey(_ key: String) -> String {
        key.map { character in
            character.isLetter || character.isNumber || character == "." || character == "_" || character == "-"
                ? String(character)
                : "_"
        }.joined()
    }

    private static func sanitizeValue(key: String, value: String) -> String {
        let lower = key.lowercased()
        let isSensitive = lower.contains("token")
            || lower.contains("secret")
            || lower.contains("private")
            || lower.contains("shared")
            || lower.contains("session")
            || lower.contains("payload")
            || lower.contains("signature")
            || lower.contains("transaction")
            || lower.contains("ciphertext")
            || lower.contains("plaintext")
        if isSensitive {
            // Opt-in raw mode (debug sessions) logs the full value so payloads /
            // signatures can be diffed on-device; otherwise redact as before.
            return allowRawValues ? String(value.prefix(rawValueCap)) : "[redacted]"
        }
        return String(value.prefix(redactedValueCap))
    }

    private static func quote(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\""
    }
}
