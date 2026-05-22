// Canonical JSON encoder — mirrors the Android voucher canonicalizer so the
// SHA-256 hash + Ed25519 signature is bit-identical across platforms.
// Rules: lexicographic key ordering, no whitespace, UTF-8 NFC normalization,
// numbers as JSON without trailing zeros, strings JSON-escaped per RFC 8259.
import Foundation

enum AgenticCanonicalJSON {
    enum Error: Swift.Error {
        case unsupportedType(String)
    }

    /// Serialize a JSON-compatible value (`[String: Any]`, `[Any]`, `String`,
    /// `Int`, `Double`, `Bool`, `NSNull`) to a canonical UTF-8 byte sequence.
    static func encode(_ value: Any) throws -> Data {
        let s = try canonicalize(value)
        return Data(s.utf8)
    }

    private static func canonicalize(_ value: Any) throws -> String {
        if value is NSNull { return "null" }
        if let b = value as? Bool { return b ? "true" : "false" }
        if let n = value as? NSNumber {
            // NSNumber covers Int, Double, Bool. Bool is handled above; we
            // need to distinguish integer vs floating value here.
            if CFNumberIsFloatType(n) {
                return formatDouble(n.doubleValue)
            }
            return String(n.int64Value)
        }
        if let i = value as? Int { return String(i) }
        if let i = value as? Int64 { return String(i) }
        if let d = value as? Double { return formatDouble(d) }
        if let s = value as? String {
            return "\"" + escapeJSONString(s.precomposedStringWithCanonicalMapping) + "\""
        }
        if let arr = value as? [Any] {
            let parts = try arr.map { try canonicalize($0) }
            return "[" + parts.joined(separator: ",") + "]"
        }
        if let dict = value as? [String: Any] {
            let keys = dict.keys.sorted()
            let parts = try keys.map { key -> String in
                let k = "\"" + escapeJSONString(key.precomposedStringWithCanonicalMapping) + "\""
                let v = try canonicalize(dict[key] ?? NSNull())
                return k + ":" + v
            }
            return "{" + parts.joined(separator: ",") + "}"
        }
        throw Error.unsupportedType(String(describing: type(of: value)))
    }

    private static func formatDouble(_ d: Double) -> String {
        if d.isNaN || d.isInfinite {
            return "null"
        }
        if d == d.rounded() && abs(d) < 1e17 {
            return String(Int64(d))
        }
        // Strip trailing zeros from %.17g representation; collapse "1.0" -> "1".
        var s = String(format: "%.17g", d)
        if s.contains(".") && !s.contains("e") && !s.contains("E") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s
    }

    private static func escapeJSONString(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out.append("\\\"")
            case 0x5C: out.append("\\\\")
            case 0x08: out.append("\\b")
            case 0x0C: out.append("\\f")
            case 0x0A: out.append("\\n")
            case 0x0D: out.append("\\r")
            case 0x09: out.append("\\t")
            case 0x00..<0x20:
                out.append(String(format: "\\u%04x", scalar.value))
            default:
                out.append(Character(scalar))
            }
        }
        return out
    }
}
