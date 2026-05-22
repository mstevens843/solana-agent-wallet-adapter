// Swift port of apps/android-twa/.../agent/runtime/. The Android side splits this
// across AgentRuntimeController + RuntimeRegistry + RequestQueue + ProviderExecutor
// + AgentRuntimeService (foreground service). On iOS we collapse into one Swift
// actor because the OS forbids long-lived foreground services — backgrounding is
// handled via `UIApplication.beginBackgroundTask` and short-tail completion
// notifications (Phase 3.3 of the plan).
import CryptoKit
import Foundation
import Security
import UIKit

// MARK: - Config

struct AgenticAgentRuntimeConfig: Codable, Equatable {
    let provider: String
    let apiFormat: String
    let model: String
    let baseUrl: String?
    let apiKey: String?
    let walletAddress: String?

    static let supportedApiFormats: Set<String> = ["openai-compatible", "anthropic"]

    static func canonicalApiFormat(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == "openai" ? "openai-compatible" : trimmed
    }

    static func fromJson(_ json: [String: Any]?) -> AgenticAgentRuntimeConfig? {
        guard let json else { return nil }
        let provider = (json["provider"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let apiFormat = canonicalApiFormat(json["apiFormat"] as? String ?? "")
        let model = (json["model"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let baseUrl = (json["baseUrl"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let apiKey = (json["apiKey"] as? String)
        let walletAddress = (json["walletAddress"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if provider.isEmpty && apiFormat.isEmpty && model.isEmpty && (apiKey?.isEmpty ?? true) {
            return nil
        }
        return AgenticAgentRuntimeConfig(
            provider: provider,
            apiFormat: apiFormat,
            model: model,
            baseUrl: (baseUrl?.isEmpty == false) ? baseUrl : nil,
            apiKey: (apiKey?.isEmpty == false) ? apiKey : nil,
            walletAddress: (walletAddress?.isEmpty == false) ? walletAddress : nil
        )
    }

    func validationError() -> AgenticAgentError? {
        if provider.isEmpty {
            return AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_PROVIDER", message: "Device Agent config is missing provider.")
        }
        if apiFormat.isEmpty || !Self.supportedApiFormats.contains(apiFormat) {
            return AgenticAgentError(code: "INVALID_CONFIG", subcode: "UNSUPPORTED_FORMAT", message: "Device Agent apiFormat must be one of: \(Self.supportedApiFormats.sorted().joined(separator: ", ")).")
        }
        if model.isEmpty {
            return AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_MODEL", message: "Device Agent config is missing model.")
        }
        if apiKey == nil || apiKey?.isEmpty == true {
            return AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_API_KEY", message: "Device Agent config is missing apiKey.")
        }
        return nil
    }

    func redactedJson() -> [String: Any] {
        return [
            "provider": provider,
            "apiFormat": apiFormat,
            "model": model,
            "baseUrl": baseUrl ?? "",
        ]
    }
}

// MARK: - Error envelope

struct AgenticAgentError: Error {
    let code: String
    let subcode: String?
    let message: String

    init(code: String, subcode: String? = nil, message: String) {
        self.code = code
        self.subcode = subcode
        self.message = message
    }

    var asJson: [String: Any] {
        var dict: [String: Any] = ["code": code, "message": message]
        if let subcode { dict["subcode"] = subcode }
        return dict
    }
}

// MARK: - Runtime state

enum AgenticAgentRuntimeState: String {
    case uninitialized
    case configured
    case running
    case stopped
    case error
}

// MARK: - Runtime singleton

final class AgenticAgentRuntime {
    static let shared = AgenticAgentRuntime()

    private let queue = DispatchQueue(label: "com.agentic.wallet.deviceagent", qos: .userInitiated)
    private let keychainService = "com.agentic.wallet.securestate"
    private let configKey = "deviceAgentConfig"

    private var _state: AgenticAgentRuntimeState = .uninitialized
    private var _config: AgenticAgentRuntimeConfig?
    private var _lastError: String?
    private var _updatedAtMs: Int64 = 0

    private init() {
        if let cached = readConfigFromKeychain() {
            _config = cached
            _state = cached.validationError() == nil ? .configured : .error
            _updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        }
    }

    func status() -> [String: Any] {
        return queue.sync {
            buildStatusJson()
        }
    }

    func configure(_ json: [String: Any]) -> [String: Any] {
        return queue.sync {
            if json["clear"] as? Bool == true {
                _config = nil
                _state = .uninitialized
                _lastError = nil
                deleteConfigFromKeychain()
                _updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                return buildStatusJson()
            }
            guard let cfg = AgenticAgentRuntimeConfig.fromJson(json) else {
                _lastError = "Empty config payload"
                _state = .error
                return buildStatusJson()
            }
            if let err = cfg.validationError() {
                _config = cfg
                _lastError = err.message
                _state = .error
                writeConfigToKeychain(cfg)
                _updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                return buildStatusJson()
            }
            _config = cfg
            _lastError = nil
            _state = .configured
            writeConfigToKeychain(cfg)
            _updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            return buildStatusJson()
        }
    }

    func start(_ json: [String: Any]) -> [String: Any] {
        return queue.sync {
            // Merge fresh config if provided; otherwise use existing.
            if !json.isEmpty {
                if let merged = AgenticAgentRuntimeConfig.fromJson(json) {
                    _config = merged
                    writeConfigToKeychain(merged)
                }
            }
            guard let cfg = _config else {
                _lastError = "No configured Device Agent."
                _state = .error
                return buildStatusJson()
            }
            if let err = cfg.validationError() {
                _lastError = err.message
                _state = .error
                return buildStatusJson()
            }
            _state = .running
            _lastError = nil
            _updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            return buildStatusJson()
        }
    }

    func stop() -> [String: Any] {
        return queue.sync {
            _state = .stopped
            _updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            return buildStatusJson()
        }
    }

    func generatePlan(_ payload: [String: Any], completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        dispatch(method: "generatePlan", systemPrompt: AgenticDeviceAgentSystemPrompts.plan, payload: payload, completion: completion)
    }

    func reviewPlan(_ payload: [String: Any], completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        dispatch(method: "reviewPlan", systemPrompt: AgenticDeviceAgentSystemPrompts.review, payload: payload) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(var data):
                // Server-side hasBlockingFailure enforcement: mirrors the cloud
                // aiPlanner's `applyServerSideReviewSafety`. If context.policyBundle
                // had blocking failures and the LLM still approved, force-deny so a
                // user-supplied rule can never be bypassed by LLM reasoning alone.
                data = AgenticPolicyBundleEnforcer.enforce(reviewResult: data, payload: payload)
                completion(.success(data))
            }
        }
    }

    func ask(_ payload: [String: Any], completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        dispatch(method: "ask", systemPrompt: AgenticDeviceAgentSystemPrompts.ask, payload: payload, completion: completion)
    }

    // MARK: - Dispatch

    private func dispatch(
        method: String,
        systemPrompt: String,
        payload: [String: Any],
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let captured: (AgenticAgentRuntimeConfig?, AgenticAgentRuntimeState) = queue.sync { (_config, _state) }
        guard let cfg = captured.0 else {
            completion(.failure(AgenticAgentError(code: "NOT_CONFIGURED", message: "Device Agent is not configured.")))
            return
        }
        guard captured.1 == .running || captured.1 == .configured else {
            completion(.failure(AgenticAgentError(code: "NOT_STARTED", message: "Device Agent is not running.")))
            return
        }
        if let err = cfg.validationError() {
            completion(.failure(err))
            return
        }
        let userInstruction = (payload["instruction"] as? String) ?? ""
        let context = payload["context"]
        let provider = AgenticAgentProviderFactory.make(for: cfg)

        // Background task — gives ~30s if the app is backgrounded mid-request.
        var bgTaskId = UIBackgroundTaskIdentifier.invalid
        DispatchQueue.main.async {
            bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "agentic-device-agent-\(method)") {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }

        let request = AgenticAgentRequest(
            method: method,
            systemPrompt: systemPrompt,
            userInstruction: userInstruction,
            context: context,
            config: cfg
        )

        provider.execute(request: request) { [weak self] result in
            DispatchQueue.main.async {
                if bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTaskId)
                    bgTaskId = .invalid
                }
            }
            switch result {
            case .success(let data):
                self?.queue.async {
                    self?._updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                }
                completion(.success(data))
            case .failure(let err):
                self?.queue.async {
                    self?._lastError = err.message
                }
                AgenticIOSLog.fail("AgenticDeviceAgent", method, "FAIL", "provider error", [
                    "code": err.code,
                    "subcode": err.subcode ?? "",
                ])
                completion(.failure(err))
            }
        }
    }

    // MARK: - Status

    private func buildStatusJson() -> [String: Any] {
        var status: [String: Any] = [
            "available": true,
            "enabled": _state != .uninitialized,
            "configured": _config != nil && _config?.validationError() == nil,
            "state": _state.rawValue,
            "runtime": "ios-native",
            "updatedAt": _updatedAtMs,
            "checkedAt": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        if let cfg = _config {
            status["provider"] = cfg.provider
            status["apiFormat"] = cfg.apiFormat
            status["baseUrl"] = cfg.baseUrl ?? ""
            status["model"] = cfg.model
        }
        if let err = _lastError {
            status["lastError"] = err
            status["message"] = err
        } else {
            status["message"] = "Ready"
        }
        return status
    }

    // MARK: - Keychain persistence

    private func writeConfigToKeychain(_ cfg: AgenticAgentRuntimeConfig) {
        guard let data = try? JSONEncoder().encode(cfg) else { return }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: configKey,
        ]
        let updateStatus = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    private func readConfigFromKeychain() -> AgenticAgentRuntimeConfig? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: configKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(AgenticAgentRuntimeConfig.self, from: data)
    }

    private func deleteConfigFromKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: configKey,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Provider abstraction

struct AgenticAgentRequest {
    let method: String
    let systemPrompt: String
    let userInstruction: String
    let context: Any?
    let config: AgenticAgentRuntimeConfig
}

protocol AgenticAgentProvider {
    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void)
}

enum AgenticAgentProviderFactory {
    static func make(for config: AgenticAgentRuntimeConfig) -> AgenticAgentProvider {
        switch config.apiFormat {
        case "anthropic":
            return AgenticAnthropicProvider()
        default:
            return AgenticOpenAICompatibleProvider()
        }
    }
}

// MARK: - Anthropic provider

final class AgenticAnthropicProvider: AgenticAgentProvider {
    private let defaultBase = "https://api.anthropic.com/v1/messages"

    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        guard let apiKey = request.config.apiKey, !apiKey.isEmpty else {
            completion(.failure(AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_API_KEY", message: "Anthropic provider requires an API key.")))
            return
        }
        let endpoint = (request.config.baseUrl?.isEmpty == false) ? request.config.baseUrl! : defaultBase
        guard let url = URL(string: endpoint) else {
            completion(.failure(AgenticAgentError(code: "INVALID_URL", message: "Invalid baseUrl: \(endpoint)")))
            return
        }
        var userBlocks: [[String: Any]] = [
            ["type": "text", "text": request.userInstruction]
        ]
        if let context = request.context {
            if let data = try? JSONSerialization.data(withJSONObject: context, options: []),
               let json = String(data: data, encoding: .utf8) {
                userBlocks.append(["type": "text", "text": "context=\(json)"])
            }
        }
        let body: [String: Any] = [
            "model": request.config.model,
            "max_tokens": 4096,
            "system": request.systemPrompt,
            "messages": [["role": "user", "content": userBlocks]],
        ]
        guard let payload = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            completion(.failure(AgenticAgentError(code: "ENCODE_ERROR", message: "Could not encode Anthropic request body.")))
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        req.httpBody = payload
        AgenticAgentHttp.execute(req, secret: apiKey) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                guard let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                    completion(.failure(AgenticAgentError(code: "PROVIDER_RESPONSE", message: "Anthropic response was not JSON.")))
                    return
                }
                let text = AgenticAnthropicProvider.extractText(json) ?? ""
                completion(.success([
                    "method": request.method,
                    "provider": "anthropic",
                    "text": text,
                    "raw": json,
                ]))
            }
        }
    }

    private static func extractText(_ json: [String: Any]) -> String? {
        guard let content = json["content"] as? [[String: Any]] else { return nil }
        let parts = content.compactMap { block -> String? in
            guard let type = block["type"] as? String, type == "text" else { return nil }
            return block["text"] as? String
        }
        return parts.joined()
    }
}

// MARK: - OpenAI-compatible provider

final class AgenticOpenAICompatibleProvider: AgenticAgentProvider {
    private let defaultBase = "https://api.openai.com/v1/chat/completions"

    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        guard let apiKey = request.config.apiKey, !apiKey.isEmpty else {
            completion(.failure(AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_API_KEY", message: "OpenAI-compatible provider requires an API key.")))
            return
        }
        let endpoint = (request.config.baseUrl?.isEmpty == false) ? request.config.baseUrl! : defaultBase
        guard let url = URL(string: endpoint) else {
            completion(.failure(AgenticAgentError(code: "INVALID_URL", message: "Invalid baseUrl: \(endpoint)")))
            return
        }
        var contextString = ""
        if let context = request.context,
           let data = try? JSONSerialization.data(withJSONObject: context, options: []),
           let json = String(data: data, encoding: .utf8) {
            contextString = "\n\ncontext=\(json)"
        }
        let body: [String: Any] = [
            "model": request.config.model,
            "messages": [
                ["role": "system", "content": request.systemPrompt],
                ["role": "user", "content": request.userInstruction + contextString],
            ],
            "max_tokens": 4096,
            "temperature": 0.3,
        ]
        guard let payload = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            completion(.failure(AgenticAgentError(code: "ENCODE_ERROR", message: "Could not encode request body.")))
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = payload
        AgenticAgentHttp.execute(req, secret: apiKey) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                guard let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                    completion(.failure(AgenticAgentError(code: "PROVIDER_RESPONSE", message: "OpenAI response was not JSON.")))
                    return
                }
                let text = AgenticOpenAICompatibleProvider.extractText(json) ?? ""
                completion(.success([
                    "method": request.method,
                    "provider": request.config.provider,
                    "text": text,
                    "raw": json,
                ]))
            }
        }
    }

    private static func extractText(_ json: [String: Any]) -> String? {
        guard let choices = json["choices"] as? [[String: Any]],
              let first = choices.first,
              let message = first["message"] as? [String: Any],
              let content = message["content"] as? String else { return nil }
        return content
    }
}

// MARK: - HTTP helper

enum AgenticAgentHttp {
    static func execute(_ request: URLRequest, secret: String?, completion: @escaping (Result<Data, AgenticAgentError>) -> Void) {
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: request) { data, response, error in
            if let error {
                let redacted = AgenticSecretRedactor.redact(error.localizedDescription, secret: secret)
                completion(.failure(AgenticAgentError(code: "NETWORK_ERROR", message: redacted)))
                return
            }
            guard let http = response as? HTTPURLResponse, let data else {
                completion(.failure(AgenticAgentError(code: "NETWORK_ERROR", message: "No response body")))
                return
            }
            if !(200..<300).contains(http.statusCode) {
                let bodyString = String(data: data, encoding: .utf8) ?? ""
                let redacted = AgenticSecretRedactor.redact(bodyString, secret: secret)
                completion(.failure(AgenticAgentError(code: "PROVIDER_HTTP_\(http.statusCode)", message: "HTTP \(http.statusCode): \(redacted.prefix(500))")))
                return
            }
            completion(.success(data))
        }
        task.resume()
    }
}
