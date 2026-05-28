import Foundation

enum AgenticProviderErrorCodes {
    static let timeout = "provider_timeout"
    static let auth = "provider_auth"
    static let rateLimited = "provider_rate_limited"
    static let invalidResponse = "provider_invalid_response"
    static let invalidConfig = "provider_invalid_config"
    static let upstream = "provider_upstream"
    static let network = "provider_network"
}

enum AgenticProviderHttp {
    private static let openAIDefaultBaseUrl = "https://api.openai.com/v1"
    private static let anthropicDefaultBaseUrl = "https://api.anthropic.com/v1"
    private static let geminiDefaultNativeBaseUrl = "https://generativelanguage.googleapis.com/v1beta"

    static func mapHttpStatusToErrorCode(_ status: Int) -> String? {
        if (200...299).contains(status) { return nil }
        switch status {
        case 401, 403:
            return AgenticProviderErrorCodes.auth
        case 429:
            return AgenticProviderErrorCodes.rateLimited
        case 408, 504:
            return AgenticProviderErrorCodes.timeout
        case 500...599:
            return AgenticProviderErrorCodes.upstream
        default:
            return AgenticProviderErrorCodes.invalidResponse
        }
    }

    static func normalizeBaseUrl(_ raw: String?, apiFormat: String) -> String {
        let trimmed = trimTrailingSlashes((raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        if trimmed.isEmpty {
            return apiFormat == "anthropic" ? anthropicDefaultBaseUrl : openAIDefaultBaseUrl
        }
        if apiFormat == "anthropic" {
            return contains(trimmed, pattern: #"/v\d+(/|$)"#) ? trimmed : "\(trimmed)/v1"
        }
        if contains(trimmed, pattern: #"/v\d+(beta)?(/|$)"#) || contains(trimmed, pattern: #"/openai$"#) {
            return trimmed
        }
        return "\(trimmed)/v1"
    }

    static func normalizeNativeBaseUrl(_ raw: String?) -> String {
        let trimmed = trimTrailingSlashes((raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        if trimmed.isEmpty { return geminiDefaultNativeBaseUrl }
        let stripped = replace(trimmed, pattern: #"/openai/?$"#, with: "")
        if contains(stripped, pattern: #"/v\d+(beta)?(/|$)"#) { return stripped }
        return "\(stripped)/v1beta"
    }

    static func isDefaultTemperatureOnlyModel(_ model: String) -> Bool {
        let normalized = model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized.isEmpty { return false }
        return normalized.hasPrefix("gpt-5") ||
            normalized.contains("/gpt-5") ||
            contains(normalized, pattern: #"^o\d"#) ||
            normalized.hasPrefix("o-") ||
            normalized.contains("/o1") ||
            normalized.contains("/o3") ||
            normalized.contains("/o4")
    }

    static func tokenLimitKey(_ model: String) -> String {
        return isDefaultTemperatureOnlyModel(model) ? "max_completion_tokens" : "max_tokens"
    }

    static func isReasoningModel(_ model: String) -> Bool {
        return isDefaultTemperatureOnlyModel(model)
    }

    static func assertApiKeyHeaderSafe(_ value: String) throws {
        if value.isEmpty {
            throw AgenticAgentError(
                code: AgenticProviderErrorCodes.invalidConfig,
                message: "AI API key is empty. Re-enter the key from the provider dashboard."
            )
        }
        for scalar in value.unicodeScalars {
            if scalar.value < 0x21 || scalar.value > 0x7e {
                throw AgenticAgentError(
                    code: AgenticProviderErrorCodes.invalidConfig,
                    message: "AI API key contains unsupported characters. Paste the key again as plain text and remove hidden separators or non-ASCII characters."
                )
            }
        }
    }

    static func composeErrorMessage(status: Int, body: String) -> String {
        let rawMessage = extractProviderErrorMessage(body)
        let base = rawMessage.isEmpty ? "AI provider returned HTTP \(status)." : rawMessage
        let explanation = providerStatusExplanation(status)
        if explanation.isEmpty { return base.trimmingCharacters(in: .whitespacesAndNewlines) }
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        let terminal = trimmed.hasSuffix(".") || trimmed.hasSuffix("?") || trimmed.hasSuffix("!")
        return terminal ? "\(trimmed) \(explanation)" : "\(trimmed). \(explanation)"
    }

    static func providerStatusExplanation(_ status: Int) -> String {
        switch status {
        case 400:
            return "That means the provider rejected the request before drafting. Check the API key, selected model, API format, base URL, and whether this key can use that model."
        case 401:
            return "That means the key is missing, invalid, or not being sent correctly. Re-enter the API key and make sure it belongs to this provider."
        case 403:
            return "That means the key reached the provider but is not allowed to use this model or project. Check permissions, billing, and provider access."
        case 404:
            return "That usually means the model or endpoint was not found. Check the model name, API format, and base URL."
        case 408:
            return "That means the provider took too long to answer. Try again, or use a smaller or faster model."
        case 409:
            return "That means the provider reported a temporary conflict. Retry the draft in a moment."
        case 422:
            return "That means the provider could not accept part of the request. Check the model, response format, and request settings."
        case 429:
            return "That means too many requests or quota is exhausted. Wait a minute, reduce retries, or check the provider quota and billing."
        case 500:
            return "That means the provider hit an internal error. Retry in a moment or switch models."
        case 502:
            return "That means a gateway between Agentic and the provider failed. Retry in a moment."
        case 503:
            return "That means the provider is temporarily unavailable or overloaded. Wait a little and retry; the API key is usually not the problem."
        case 504:
            return "That means the provider timed out before finishing. Retry, or choose a faster model."
        default:
            if (400...499).contains(status) {
                return "That means the provider rejected the request. Check key permissions, model name, base URL, and provider settings."
            }
            if (500...599).contains(status) {
                return "That means the provider had a temporary server-side problem. Retry in a moment or switch models."
            }
            return ""
        }
    }

    private static func extractProviderErrorMessage(_ body: String) -> String {
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let data = body.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            return ""
        }
        if let error = parsed["error"] as? String { return error }
        if let error = parsed["error"] as? [String: Any],
           let message = error["message"] as? String {
            return message
        }
        return ""
    }

    private static func trimTrailingSlashes(_ value: String) -> String {
        var out = value
        while out.hasSuffix("/") {
            out.removeLast()
        }
        return out
    }

    private static func contains(_ value: String, pattern: String) -> Bool {
        return value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func replace(_ value: String, pattern: String, with replacement: String) -> String {
        return value.replacingOccurrences(of: pattern, with: replacement, options: [.regularExpression, .caseInsensitive])
    }
}
