import Foundation

enum AgenticIOSNativeLog {
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
        let line = "[AgentIOSNative] [\(component)] \(method) | \(step) phase=\(phase) message=\(quote(message))"
        print(suffix.isEmpty ? line : "\(line) \(suffix)")
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
        if lower.contains("token")
            || lower.contains("secret")
            || lower.contains("private")
            || lower.contains("shared")
            || lower.contains("session")
            || lower.contains("payload")
            || lower.contains("signature")
            || lower.contains("transaction")
            || lower.contains("ciphertext")
            || lower.contains("plaintext") {
            return "[redacted]"
        }
        return String(value.prefix(240))
    }

    private static func quote(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\""
    }
}
