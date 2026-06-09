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
        if let apiKey {
            do {
                try AgenticProviderHttp.assertApiKeyHeaderSafe(apiKey)
            } catch let error as AgenticAgentError {
                return error
            } catch {
                return AgenticAgentError(code: AgenticProviderErrorCodes.invalidConfig, message: "Device Agent config has an invalid apiKey.")
            }
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

struct AgenticAgentError: Error, LocalizedError {
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

    var errorDescription: String? {
        message
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

private final class AgenticBackgroundTask {
    private let name: String
    private let onExpiration: (() -> Void)?
    private var id = UIBackgroundTaskIdentifier.invalid
    private var ended = false

    init(name: String, onExpiration: (() -> Void)? = nil) {
        self.name = name
        self.onExpiration = onExpiration
    }

    func begin() {
        DispatchQueue.main.async {
            self.beginOnMain()
        }
    }

    func end() {
        DispatchQueue.main.async {
            self.endOnMain()
        }
    }

    private func beginOnMain() {
        guard !ended, id == .invalid else { return }
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            self?.onExpiration?()
            self?.endOnMain()
        }
    }

    private func endOnMain() {
        guard !ended else { return }
        ended = true
        let current = id
        id = .invalid
        if current != .invalid {
            UIApplication.shared.endBackgroundTask(current)
        }
    }
}

final class AgenticAgentDispatchContext {
    let requestId: String
    let method: String
    let provider: AgenticAgentProvider

    private let lock = NSLock()
    private lazy var backgroundTask = AgenticBackgroundTask(name: "agentic-device-agent-\(method)") { [weak self] in
        self?.expire(subcode: "BACKGROUND_EXPIRED", message: "iOS ended the Device Agent background completion window.")
    }
    private var finished = false
    private var timeoutWorkItem: DispatchWorkItem?
    private let startedAt = Date()
    private let onComplete: (Result<[String: Any], AgenticAgentError>, Int) -> Void

    init(
        requestId: String,
        method: String,
        provider: AgenticAgentProvider,
        timeoutSeconds: TimeInterval,
        onComplete: @escaping (Result<[String: Any], AgenticAgentError>, Int) -> Void
    ) {
        self.requestId = requestId
        self.method = method
        self.provider = provider
        self.onComplete = onComplete
        let timeout = DispatchWorkItem { [weak self] in
            self?.expire(subcode: "REQUEST_TIMEOUT", message: "Device Agent \(method) request timed out.")
        }
        timeoutWorkItem = timeout
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeoutSeconds, execute: timeout)
    }

    func beginBackgroundTask() {
        backgroundTask.begin()
    }

    func complete(
        _ result: Result<[String: Any], AgenticAgentError>
    ) {
        guard markFinished() else {
            AgenticIOSLog.fail("AgenticDeviceAgent", method, "LATE_COMPLETION_IGNORED", "Device Agent completion arrived after the request was already finished.", [
                "requestId": requestId,
                "durationMs": String(durationMs()),
            ])
            return
        }
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        backgroundTask.end()
        onComplete(result, durationMs())
    }

    func durationMs() -> Int {
        Int(Date().timeIntervalSince(startedAt) * 1000)
    }

    @discardableResult
    func markFinished() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if finished { return false }
        finished = true
        return true
    }

    private func expire(subcode: String, message: String) {
        complete(.failure(AgenticAgentError(
            code: AgenticProviderErrorCodes.timeout,
            subcode: subcode,
            message: message
        )))
    }
}

enum AgenticDeviceAgentDebugTelemetry {
    private static let lock = NSLock()
    private static var nextEventIndex = 0

    static func emit(baseUrl: String?, fields: [String: String]) {
        var indexedFields = fields
        indexedFields["eventIndex"] = String(claimEventIndex())
        indexedFields["source"] = indexedFields["source"] ?? "ios-device-agent"
        if indexedFields["appBuild"] == nil, let appBuild = appBuild() {
            indexedFields["appBuild"] = appBuild
        }
        guard let endpoint = endpoint(baseUrl: baseUrl),
              JSONSerialization.isValidJSONObject(indexedFields),
              let body = try? JSONSerialization.data(withJSONObject: indexedFields, options: []) else {
            return
        }
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("ios-bundled", forHTTPHeaderField: "x-agentic-client")
        request.httpBody = body
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: request) { _, _, _ in
            session.finishTasksAndInvalidate()
        }
        task.resume()
    }

    private static func claimEventIndex() -> Int {
        lock.lock()
        defer { lock.unlock() }
        nextEventIndex += 1
        return nextEventIndex
    }

    private static func appBuild() -> String? {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String
        let build = info?["CFBundleVersion"] as? String
        switch (version, build) {
        case (.some(let version), .some(let build)):
            return "\(version)(\(build))"
        case (.some(let version), .none):
            return version
        case (.none, .some(let build)):
            return build
        default:
            return nil
        }
    }

    private static func endpoint(baseUrl: String?) -> URL? {
        guard let raw = baseUrl,
              let base = URL(string: raw),
              base.scheme == "https" || base.scheme == "http" else {
            return nil
        }
        return URL(string: "/api/mobile-device-agent-debug", relativeTo: base)?.absoluteURL
    }
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
                AgenticIOSLog.info("AgenticDeviceAgent", "configure", "CLEAR", "Device Agent config cleared")
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
                AgenticIOSLog.fail("AgenticDeviceAgent", "configure", "INVALID_CONFIG", err.message, [
                    "provider": cfg.provider,
                    "model": cfg.model,
                    "subcode": err.subcode ?? "",
                ])
                return buildStatusJson()
            }
            _config = cfg
            _lastError = nil
            _state = .configured
            writeConfigToKeychain(cfg)
            _updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            AgenticIOSLog.info("AgenticDeviceAgent", "configure", "DONE", "Device Agent config stored", [
                "provider": cfg.provider,
                "model": cfg.model,
                "apiFormat": cfg.apiFormat,
                "hasKey": cfg.apiKey?.isEmpty == false ? "true" : "false",
            ])
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
                AgenticIOSLog.fail("AgenticDeviceAgent", "start", "FAIL", "No configured Device Agent.")
                return buildStatusJson()
            }
            if let err = cfg.validationError() {
                _lastError = err.message
                _state = .error
                AgenticIOSLog.fail("AgenticDeviceAgent", "start", "INVALID_CONFIG", err.message, [
                    "provider": cfg.provider,
                    "model": cfg.model,
                    "subcode": err.subcode ?? "",
                ])
                return buildStatusJson()
            }
            _state = .running
            _lastError = nil
            _updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            AgenticIOSLog.info("AgenticDeviceAgent", "start", "RUNNING", "Device Agent runtime marked running", [
                "provider": cfg.provider,
                "model": cfg.model,
            ])
            return buildStatusJson()
        }
    }

    func stop() -> [String: Any] {
        return queue.sync {
            _state = .stopped
            _updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            AgenticIOSLog.info("AgenticDeviceAgent", "stop", "STOPPED", "Device Agent runtime stopped")
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
        let requestId = requestId(from: payload)
        let payloadBytes = payloadByteCount(payload)
        let startState = sharedStateName(captured.1)
        let provider = AgenticAgentProviderFactory.make(for: cfg)
        let request = AgenticAgentRequest(
            requestId: requestId,
            method: method,
            systemPrompt: systemPrompt,
            userInstruction: userInstruction,
            context: context,
            payload: payload,
            payloadBytes: payloadBytes,
            config: cfg
        )

        let dispatchContext = AgenticAgentDispatchContext(
            requestId: requestId,
            method: method,
            provider: provider,
            timeoutSeconds: 125
        ) { [weak self] result, durationMs in
            switch result {
            case .success(let data):
                self?.queue.async {
                    self?._updatedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                }
                request.emitDebug(step: "success", [
                    "durationMs": String(durationMs),
                    "statusState": startState,
                    "configured": "true",
                ])
                AgenticIOSLog.info("AgenticDeviceAgent", method, "SUCCESS", "provider request completed", [
                    "requestId": requestId,
                    "durationMs": String(durationMs),
                    "provider": cfg.provider,
                    "model": cfg.model,
                ])
                completion(.success(data))
            case .failure(let err):
                self?.queue.async {
                    self?._lastError = err.message
                }
                request.emitDebug(step: "fail", [
                    "durationMs": String(durationMs),
                    "code": err.code,
                    "subcode": err.subcode ?? "",
                    "message": err.message,
                ])
                AgenticIOSLog.fail("AgenticDeviceAgent", method, "FAIL", "provider error", [
                    "requestId": requestId,
                    "code": err.code,
                    "subcode": err.subcode ?? "",
                    "durationMs": String(durationMs),
                ])
                completion(.failure(err))
            }
        }
        dispatchContext.beginBackgroundTask()
        AgenticIOSLog.info("AgenticDeviceAgent", method, "START", "provider request started", [
            "requestId": requestId,
            "state": startState,
            "provider": cfg.provider,
            "model": cfg.model,
            "bodyBytes": String(payloadBytes),
            "researchNeeded": AgenticAgentProviderSupport.researchNeeded(payload) ? "true" : "false",
        ])
        request.emitDebug(step: "native_start", [
            "payloadChars": String(payloadBytes),
            "statusState": startState,
            "configured": "true",
        ])
        dispatchContext.provider.execute(request: request) { result in
            dispatchContext.complete(result)
        }
    }

    private func requestId(from payload: [String: Any]) -> String {
        if let raw = payload["__agenticRequestId"] as? String,
           raw.range(of: #"^[A-Za-z0-9_.:-]{1,160}$"#, options: .regularExpression) != nil {
            return raw
        }
        return "ios-device-agent-\(UUID().uuidString)"
    }

    private func payloadByteCount(_ payload: [String: Any]) -> Int {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
            return 0
        }
        return data.count
    }

    // MARK: - Status

    private func buildStatusJson() -> [String: Any] {
        var status: [String: Any] = [
            "available": true,
            "enabled": _state != .uninitialized,
            "configured": _config != nil && _config?.validationError() == nil,
            "state": sharedStateName(_state),
            "runtime": "ios-native",
            "updatedAt": isoTimestamp(_updatedAtMs),
            "checkedAt": isoTimestamp(Int64(Date().timeIntervalSince1970 * 1000)),
        ]
        if let cfg = _config {
            status["provider"] = cfg.provider
            status["apiFormat"] = cfg.apiFormat
            status["baseUrl"] = cfg.baseUrl ?? ""
            status["model"] = cfg.model
        }
        if let err = _lastError {
            status["lastError"] = [
                "code": "runtime_error",
                "message": err,
            ]
            status["message"] = err
        } else {
            status["message"] = "Ready"
        }
        return status
    }

    private func sharedStateName(_ state: AgenticAgentRuntimeState) -> String {
        switch state {
        case .uninitialized:
            return "unavailable"
        case .configured:
            return "stopped"
        case .running:
            return "running"
        case .stopped:
            return "stopped"
        case .error:
            return "error"
        }
    }

    private func isoTimestamp(_ millis: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(millis) / 1000.0)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
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
    let requestId: String
    let method: String
    let systemPrompt: String
    let userInstruction: String
    let context: Any?
    let payload: [String: Any]
    let payloadBytes: Int
    let config: AgenticAgentRuntimeConfig
}

extension AgenticAgentRequest {
    var debugBaseUrl: String? {
        payload["__agenticDebugBaseUrl"] as? String
    }

    func httpLogMetadata(provider: String, research: Bool) -> [String: String] {
        [
            "requestId": requestId,
            "method": method,
            "provider": provider,
            "model": config.model,
            "research": research ? "true" : "false",
        ]
    }

    func emitDebug(step: String, _ fields: [String: String] = [:]) {
        AgenticDeviceAgentDebugTelemetry.emit(baseUrl: debugBaseUrl, fields: [
            "method": method,
            "requestId": requestId,
            "runtime": "ios-native",
            "provider": config.provider,
            "model": config.model,
            "step": step,
        ].merging(fields) { current, _ in current })
    }
}

struct AgenticDeviceAgentMessages {
    let system: String
    let userContent: String
}

enum AgenticDeviceAgentBoundaries {
    static let plan = "AI prepares a plan only. Wallet approval and signing happen later in the user wallet."
    static let review = "This AI review can approve, deny, or request more input. It cannot sign or submit a transaction."
    static let ask = "This is conversational Q&A about a draft. It cannot sign or submit a transaction."
    static let reviewDefaultInstruction = "Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input."
}

enum AgenticDeviceAgentMessageAssembler {
    private static let connectorRuleDefault = "Only propose first-class or Blink executable actions for enabled connectors with matching capabilities. If a requested protocol/action is disabled, unsupported, or missing an action URL/client key, make the plan proof/read-only and state which connector fact, key, or action URL is missing."

    static func buildPlanMessages(_ payload: [String: Any]) -> AgenticDeviceAgentMessages {
        let protocolConnectors = array(payload["protocolConnectors"]) ?? array(payload["connectorContext"]) ?? []
        let providedRule = trimmed(payload["connectorRule"])
        let connectorRule = providedRule.isEmpty ? deriveConnectorRule(protocolConnectors) : providedRule
        let boundary = trimmed(payload["requiredBoundary"]).isEmpty ? AgenticDeviceAgentBoundaries.plan : trimmed(payload["requiredBoundary"])
        var userContent: [String: Any] = [
            "userPrompt": payload["userPrompt"] ?? payload["prompt"] ?? "",
            "protocolConnectors": protocolConnectors,
            "connectorRule": connectorRule,
            "requiredBoundary": boundary,
        ]
        for key in ["userNotes", "template", "parameters"] where payload[key] != nil {
            userContent[key] = payload[key]
        }
        return AgenticDeviceAgentMessages(system: AgenticDeviceAgentSystemPrompts.plan, userContent: stringify(userContent))
    }

    static func buildReviewMessages(_ payload: [String: Any]) -> AgenticDeviceAgentMessages {
        let instruction = trimmed(payload["instruction"]).isEmpty ? AgenticDeviceAgentBoundaries.reviewDefaultInstruction : trimmed(payload["instruction"])
        let walletAddress = trimmed(payload["walletAddress"]).isEmpty ? "not_connected" : trimmed(payload["walletAddress"])
        let cluster = trimmed(payload["cluster"]).isEmpty ? "unknown" : trimmed(payload["cluster"])
        let boundary = trimmed(payload["requiredBoundary"]).isEmpty ? AgenticDeviceAgentBoundaries.review : trimmed(payload["requiredBoundary"])
        let userContent: [String: Any] = [
            "instruction": instruction,
            "walletAddress": walletAddress,
            "cluster": cluster,
            "plan": payload["plan"] ?? [:],
            "context": payload["context"] ?? [:],
            "research": researchObject(payload),
            "requiredBoundary": boundary,
        ]
        return AgenticDeviceAgentMessages(system: AgenticDeviceAgentSystemPrompts.review, userContent: stringify(userContent))
    }

    static func buildResearchMessages(_ payload: [String: Any], researchTargets: [[String: Any]] = []) -> AgenticDeviceAgentMessages {
        let instruction = trimmed(payload["instruction"]).isEmpty ? AgenticDeviceAgentBoundaries.reviewDefaultInstruction : trimmed(payload["instruction"])
        let walletAddress = trimmed(payload["walletAddress"]).isEmpty ? "not_connected" : trimmed(payload["walletAddress"])
        let cluster = trimmed(payload["cluster"]).isEmpty ? "unknown" : trimmed(payload["cluster"])
        let hasTargets = !researchTargets.isEmpty
        let sourcePolicy = "Prefer official vendor pricing pages over blogs and aggregators. When a vendor publishes a plan/pricing page, use it as the primary source. Pricing pages are the authoritative source for current prices, fees, and plan rates. Never cite a blog subdomain (blog.*, news.*, medium.com, substack.com, community.*) as the primary source for current pricing - if only blog citations are available, state that current pricing could not be verified against an official page. Cite each fact with the official URL, not a blog post."
        let systemPrelude = hasTargets
            ? "You research current outside facts for a Solana wallet approval review. Do not approve, deny, or ask the wallet to sign. The reviewer has already broken the NOTE into atomic fact requests - see context.researchTargets. Batch your searches: cover every researchTarget in as few queries as possible. For each target, return a concise source-backed value plus a citation URL. Prefer official sources. "
            : "You research current outside facts for a Solana wallet approval review. Do not approve, deny, or ask the wallet to sign. Search reliable current sources, prefer official sources, and return concise source-backed facts in plain English. Include current prices, thresholds, dates, plan names, ambiguity, and URLs when relevant. "
        var context = record(payload["context"])
        if hasTargets { context["researchTargets"] = researchTargets }
        let userContent: [String: Any] = [
            "instruction": instruction,
            "walletAddress": walletAddress,
            "cluster": cluster,
            "plan": payload["plan"] ?? [:],
            "context": context,
            "research": [
                "needed": true,
                "mode": hasTargets ? "resolve_specific_atoms" : "collect_current_facts_only",
                "currentDate": ISO8601DateFormatter().string(from: Date()),
                "maxSearches": AgenticAgentProviderSupport.researchMaxUses(payload),
                "sourcePolicy": sourcePolicy,
            ],
            "requiredBoundary": "This research pass cannot approve, deny, sign, or submit. It only gathers facts for a later structured review.",
        ]
        return AgenticDeviceAgentMessages(system: systemPrelude + sourcePolicy, userContent: stringify(userContent))
    }

    static func buildAskMessages(_ payload: [String: Any]) -> AgenticDeviceAgentMessages {
        let walletAddress = trimmed(payload["walletAddress"]).isEmpty ? "not_connected" : trimmed(payload["walletAddress"])
        let cluster = trimmed(payload["cluster"]).isEmpty ? "unknown" : trimmed(payload["cluster"])
        let boundary = trimmed(payload["requiredBoundary"]).isEmpty ? AgenticDeviceAgentBoundaries.ask : trimmed(payload["requiredBoundary"])
        let userContent: [String: Any] = [
            "question": payload["question"] ?? "",
            "plan": payload["plan"] ?? [:],
            "walletAddress": walletAddress,
            "cluster": cluster,
            "context": payload["context"] ?? [:],
            "research": researchObject(payload),
            "requiredBoundary": boundary,
        ]
        return AgenticDeviceAgentMessages(system: AgenticDeviceAgentSystemPrompts.ask, userContent: stringify(userContent))
    }

    private static func researchObject(_ payload: [String: Any]) -> [String: Any] {
        if let research = payload["research"] as? [String: Any] { return research }
        return [
            "needed": false,
            "mode": "not_required",
            "currentDate": ISO8601DateFormatter().string(from: Date()),
            "maxSearches": AgenticAgentProviderSupport.researchMaxUses(payload),
        ]
    }

    private static func deriveConnectorRule(_ protocolConnectors: [Any]) -> String {
        guard let selected = protocolConnectors.compactMap({ $0 as? [String: Any] }).first(where: {
            ($0["selected"] as? Bool) == true || ($0["selectedOnly"] as? Bool) == true
        }) else {
            return connectorRuleDefault
        }
        let name = [trimmed(selected["name"]), trimmed(selected["id"])].first(where: { !$0.isEmpty }) ?? "selected connector"
        return [
            "Use the selected protocol connector only: \(name).",
            "Do not switch protocols.",
            "If required connector facts are missing, ask for missing facts instead of inventing execution.",
            "Do not claim the action is signed, submitted, approved, or safe.",
            "The wallet owner must approve separately.",
        ].joined(separator: " ")
    }

    private static func trimmed(_ value: Any?) -> String {
        return (value as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func record(_ value: Any?) -> [String: Any] {
        return value as? [String: Any] ?? [:]
    }

    private static func array(_ value: Any?) -> [Any]? {
        return value as? [Any]
    }

    private static func stringify(_ value: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: []),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }
}

protocol AgenticAgentProvider {
    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void)
}

enum AgenticAgentProviderSupport {
    static func messages(for request: AgenticAgentRequest, researchTargets: [[String: Any]] = []) -> AgenticDeviceAgentMessages {
        switch request.method {
        case "generatePlan":
            return AgenticDeviceAgentMessageAssembler.buildPlanMessages(request.payload)
        case "reviewPlan":
            return AgenticDeviceAgentMessageAssembler.buildReviewMessages(request.payload)
        case "ask":
            return AgenticDeviceAgentMessageAssembler.buildAskMessages(request.payload)
        case "research":
            return AgenticDeviceAgentMessageAssembler.buildResearchMessages(request.payload, researchTargets: researchTargets)
        default:
            return AgenticDeviceAgentMessages(system: request.systemPrompt, userContent: request.userInstruction)
        }
    }

    static func parseProviderResult(method: String, provider: String, text: String, raw: [String: Any], payload: [String: Any]? = nil) -> Result<[String: Any], AgenticAgentError> {
        if method == "ask" {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return .failure(AgenticAgentError(code: "PROVIDER_RESPONSE", subcode: "EMPTY_TEXT", message: "Provider response had no answer text."))
            }
            return .success(["output_text": text])
        }
        guard let parsed = AgenticProviderResponseParser.parseModelJson(text) else {
            if method == "reviewPlan" {
                return .success(malformedReview(provider: provider, text: text, raw: raw))
            }
            return .failure(AgenticAgentError(code: "PROVIDER_RESPONSE", subcode: "JSON_PARSE", message: "Provider response was not valid JSON."))
        }
        var out = parsed
        out["provider"] = provider
        if method == "reviewPlan", let payload {
            out = finalizeReviewResult(out, payload: payload)
        }
        return .success(out)
    }

    static func finalizeReviewResult(_ result: [String: Any], payload: [String: Any]) -> [String: Any] {
        var out = normalizeReviewResult(result)
        guard let context = payload["context"] as? [String: Any],
              let researchEvidence = context["researchEvidence"] as? [String: Any] else {
            return out
        }
        var evidence = out["evidence"] as? [String: Any] ?? [:]
        if evidence["research"] as? [String: Any] == nil {
            var research: [String: Any] = [
                "status": stringValue(researchEvidence["status"], fallback: "checked"),
                "required": researchEvidence["required"] as? Bool ?? true,
            ]
            if let provider = nonEmptyString(researchEvidence["provider"]) { research["provider"] = provider }
            if let checkedAt = nonEmptyString(researchEvidence["checkedAt"]) { research["checkedAt"] = checkedAt }
            evidence["research"] = research
        }
        let sources = mergeSourceRows(existing: evidence["sources"], added: researchEvidence["sources"])
        if !sources.isEmpty { evidence["sources"] = sources }
        var findings = evidence["findings"] as? [[String: Any]] ?? []
        if let summary = nonEmptyString(researchEvidence["summary"]),
           !findings.contains(where: { nonEmptyString($0["label"])?.lowercased() == "current research" }) {
            findings.append(["label": "Current research", "value": summary, "tone": "neutral"])
        }
        if !findings.isEmpty { evidence["findings"] = findings }
        out["evidence"] = evidence
        return out
    }

    private static func normalizeReviewResult(_ result: [String: Any]) -> [String: Any] {
        var out = result
        let decision = firstString(out, ["decision", "verdict", "status", "decision_status", "decisionStatus"])
        if !decision.isEmpty {
            out["decision"] = normalizeDecision(decision)
        } else if let approved = out["approved"] as? Bool {
            out["decision"] = approved ? "approve" : "deny"
        }
        if nonEmptyString(out["reason"]) == nil {
            let reason = firstString(out, ["rationale", "explanation", "why"])
            if !reason.isEmpty { out["reason"] = reason }
        }
        if nonEmptyString(out["summary"]) == nil {
            let summary = firstString(out, ["result", "answer"])
            if !summary.isEmpty { out["summary"] = summary }
        }
        var evidence = out["evidence"] as? [String: Any] ?? [:]
        for key in ["findings", "checks", "evidenceRows", "evidence_rows", "sources", "citations"] where evidence[key] == nil && out[key] != nil {
            evidence[key] = out[key]
            out.removeValue(forKey: key)
        }
        out["evidence"] = evidence
        return out
    }

    private static func mergeSourceRows(existing: Any?, added: Any?) -> [[String: Any]] {
        var out: [[String: Any]] = []
        var seen = Set<String>()
        func append(_ rows: Any?) {
            guard let rows = rows as? [[String: Any]] else { return }
            for row in rows {
                let url = nonEmptyString(row["url"]) ?? nonEmptyString(row["ref"]) ?? ""
                if url.isEmpty || seen.contains(url) { continue }
                seen.insert(url)
                var next: [String: Any] = ["url": url]
                if let title = nonEmptyString(row["title"]) { next["title"] = title }
                out.append(next)
            }
        }
        append(existing)
        append(added)
        return out
    }

    private static func firstString(_ dict: [String: Any], _ keys: [String]) -> String {
        for key in keys {
            if let value = nonEmptyString(dict[key]) { return value }
        }
        return ""
    }

    private static func normalizeDecision(_ value: String) -> String {
        let lower = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: #"[\s-]+"#, with: "_", options: .regularExpression)
        switch lower {
        case "approved", "pass", "passed", "allow":
            return "approve"
        case "denied", "reject", "rejected", "fail", "failed":
            return "deny"
        case "needsinput", "needs_input", "needs_user_input", "manual_review":
            return "needs_input"
        default:
            return lower
        }
    }

    private static func stringValue(_ value: Any?, fallback: String) -> String {
        return nonEmptyString(value) ?? fallback
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func researchNeeded(_ payload: [String: Any]) -> Bool {
        guard let research = payload["research"] as? [String: Any] else { return false }
        return (research["needed"] as? Bool) == true
    }

    static func researchMaxUses(_ payload: [String: Any]) -> Int {
        guard let research = payload["research"] as? [String: Any] else { return 3 }
        let raw = research["maxSearches"]
        let numeric: Double?
        if let value = raw as? NSNumber {
            numeric = value.doubleValue
        } else if let value = raw as? Double {
            numeric = value
        } else if let value = raw as? Int {
            numeric = Double(value)
        } else if let value = raw as? String {
            numeric = Double(value.trimmingCharacters(in: .whitespacesAndNewlines))
        } else {
            numeric = nil
        }
        guard let numeric, numeric.isFinite, numeric > 0 else { return 3 }
        return max(1, min(Int(floor(numeric)), 5))
    }

    static func researchTargets(_ payload: [String: Any]) -> [[String: Any]] {
        guard let context = payload["context"] as? [String: Any],
              let targets = context["researchTargets"] as? [[String: Any]] else { return [] }
        return targets
    }

    static func reviewPayloadWithResearch(_ payload: [String: Any], evidence: [String: Any]) -> [String: Any] {
        var next = reviewPayloadAfterResearchAttempt(payload)
        var context = next["context"] as? [String: Any] ?? [:]
        context["researchEvidence"] = evidence
        next["context"] = context
        return next
    }

    static func reviewPayloadAfterResearchAttempt(_ payload: [String: Any]) -> [String: Any] {
        var next = payload
        var research = payload["research"] as? [String: Any] ?? [:]
        research["needed"] = false
        research["mode"] = "provided_current_facts"
        research["providedEvidence"] = true
        next["research"] = research
        return next
    }

    static func researchEvidence(provider: String, summary: String, raw: [String: Any], instructionText: String) -> [String: Any] {
        let rawCitations = AgenticProviderResponseParser.extractCitations(provider: provider, raw: raw)
        let sources = AgenticCitationFilter.filterLowAuthorityCitations(rawCitations, instructionText: instructionText)
        let droppedLowAuthorityCount = max(0, rawCitations.count - sources.count)
        let pricingQuestion = AgenticCitationFilter.isPricingInstruction(instructionText)
        let suppressedPricingSummary = pricingQuestion && !rawCitations.isEmpty && sources.isEmpty
        let evidenceSummary = suppressedPricingSummary
            ? "Current pricing could not be verified against an official source. Ask the user to confirm the plan name and price."
            : (summary.isEmpty ? "Research ran but produced no summary text." : summary)
        var evidence: [String: Any] = [
            "status": "checked",
            "required": true,
            "provider": provider,
            "checkedAt": ISO8601DateFormatter().string(from: Date()),
            "summary": evidenceSummary,
            "sources": sources.map { $0.json },
            "sourcePolicy": "Prefer official sources for prices and product facts. When a vendor publishes a plan page, use it as primary. Reject blog subdomains (blog.*, news.*) as primary sources for current pricing. Cite each fact with the official URL.",
        ]
        if droppedLowAuthorityCount > 0 {
            evidence["droppedLowAuthoritySourceCount"] = droppedLowAuthorityCount
        }
        if suppressedPricingSummary {
            evidence["sourceWarning"] = "pricing_unverified_official_source"
        }
        return evidence
    }

    static func currentResearchFailedReview(provider: String, error: AgenticAgentError) -> [String: Any] {
        let reason = "Current outside facts are required before the Device Agent can decide, but \(provider) research failed: \(error.message)"
        return [
            "decision": "needs_input",
            "reason": reason,
            "summary": "Current outside facts are required before the Device Agent can decide.",
            "evidence": [
                "research": [
                    "status": "failed",
                    "provider": provider,
                    "required": true,
                    "error": error.asJson,
                ],
                "findings": [["label": "Research failed", "value": reason, "tone": "warn"]],
            ],
            "questions": [[
                "id": "device_agent_current_fact",
                "prompt": "What source-backed current value should be checked?",
                "inputKind": "text",
                "required": true,
            ]],
            "evidenceFactIds": [],
            "blockingFactIds": [],
            "missingFactIds": [],
            "confidence": "low",
        ]
    }

    static func instructionText(_ payload: [String: Any]) -> String {
        let instruction = payload["instruction"] as? String ?? ""
        if !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return instruction }
        let userPrompt = payload["userPrompt"] as? String ?? ""
        if !userPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return userPrompt }
        return payload["question"] as? String ?? ""
    }

    static func currentResearchUnavailableReview(provider: String) -> [String: Any] {
        let reason = "Device Agent \(provider) mode cannot fetch current outside facts yet. Use OpenAI, Anthropic, Gemini, or provide a source-backed current value."
        return [
            "decision": "needs_input",
            "reason": reason,
            "summary": "Current outside facts are required before the Device Agent can decide.",
            "evidence": [
                "research": ["status": "unavailable", "provider": provider, "required": true],
                "findings": [["label": "Research needed", "value": reason, "tone": "warn"]],
            ],
            "questions": [[
                "id": "device_agent_current_fact",
                "prompt": "What source-backed current value should be checked?",
                "inputKind": "text",
                "required": true,
            ]],
            "evidenceFactIds": [],
            "blockingFactIds": [],
            "missingFactIds": [],
            "confidence": "low",
        ]
    }

    static func currentResearchUnavailableAsk(provider: String) -> [String: Any] {
        return ["output_text": "I need current outside facts to answer that, but \(provider) mode does not have native web research available. Provide a source-backed value or switch to OpenAI, Anthropic, or Gemini."]
    }

    static func malformedReview(provider: String, text: String = "", raw: [String: Any] = [:]) -> [String: Any] {
        let reason = "Device Agent \(provider) returned a malformed review response. The draft needs manual review before wallet approval."
        let diagnostics = malformedReviewDiagnostics(provider: provider, text: text, raw: raw)
        return [
            "decision": "needs_input",
            "reason": reason,
            "summary": "The AI review response was not parseable.",
            "evidence": [
                "provider": provider,
                "diagnostics": diagnostics,
                "findings": [[
                    "label": "Review format",
                    "value": reason,
                    "tone": "warn",
                ]],
            ],
            "questions": [[
                "id": "device_agent_review_format",
                "prompt": "Do you want to review this draft manually?",
                "inputKind": "select",
                "options": ["Review manually", "Cancel"],
                "required": true,
            ]],
            "evidenceFactIds": [],
            "blockingFactIds": [],
            "missingFactIds": [],
            "confidence": "low",
            "provider": provider,
        ]
    }

    static func isMalformedReview(_ value: [String: Any]) -> Bool {
        guard (value["decision"] as? String) == "needs_input",
              let evidence = value["evidence"] as? [String: Any] else { return false }
        if let diagnostics = evidence["diagnostics"] as? [String: String] {
            return diagnostics["parseError"] == "json_parse"
        }
        if let diagnostics = evidence["diagnostics"] as? [String: Any] {
            return (diagnostics["parseError"] as? String) == "json_parse"
        }
        return false
    }

    static func malformedReviewDiagnostics(provider: String, text: String, raw: [String: Any]) -> [String: Any] {
        var diagnostics: [String: Any] = [
            "provider": provider,
            "parseError": "json_parse",
            "textChars": text.count,
            "textPreview": safePreview(text),
        ]
        if let finishReason = finishReason(raw) {
            diagnostics["finishReason"] = finishReason
        }
        if let candidates = raw["candidates"] as? [Any] {
            diagnostics["candidateCount"] = candidates.count
        }
        if let status = raw["status"] as? String {
            diagnostics["status"] = status
        }
        return diagnostics
    }

    static func malformedReviewDebugFields(provider: String, text: String, raw: [String: Any]) -> [String: String] {
        stringifyDiagnosticFields(malformedReviewDiagnostics(provider: provider, text: text, raw: raw))
    }

    private static func stringifyDiagnosticFields(_ diagnostics: [String: Any]) -> [String: String] {
        var fields: [String: String] = [:]
        for (key, value) in diagnostics {
            switch value {
            case let value as String:
                fields[key] = value
            case let value as Int:
                fields[key] = String(value)
            case let value as Bool:
                fields[key] = value ? "true" : "false"
            default:
                continue
            }
        }
        return fields
    }

    private static func safePreview(_ text: String) -> String {
        let compact = text
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if compact.count <= 320 { return compact }
        return String(compact.prefix(320))
    }

    private static func finishReason(_ raw: [String: Any]) -> String? {
        if let candidates = raw["candidates"] as? [[String: Any]],
           let first = candidates.first,
           let finishReason = first["finishReason"] as? String {
            return finishReason
        }
        if let output = raw["output"] as? [[String: Any]],
           let first = output.first,
           let status = first["status"] as? String {
            return status
        }
        return nil
    }

    private static func sourceList(from raw: Any) -> [[String: Any]] {
        var out: [[String: Any]] = []
        collectSources(raw, into: &out)
        var seen = Set<String>()
        return out.filter { source in
            guard let url = source["url"] as? String, !url.isEmpty, !seen.contains(url) else { return false }
            seen.insert(url)
            return true
        }
    }

    private static func collectSources(_ value: Any, into out: inout [[String: Any]]) {
        if let dict = value as? [String: Any] {
            if let url = dict["url"] as? String {
                var source: [String: Any] = ["url": url]
                if let title = dict["title"] as? String { source["title"] = title }
                out.append(source)
            }
            for child in dict.values { collectSources(child, into: &out) }
        } else if let arr = value as? [Any] {
            for child in arr { collectSources(child, into: &out) }
        }
    }

    private static func parseJsonObject(from text: String) -> [String: Any]? {
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

enum AgenticAgentProviderFactory {
    static func make(for config: AgenticAgentRuntimeConfig) -> AgenticAgentProvider {
        let provider = config.provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let format = AgenticAgentRuntimeConfig.canonicalApiFormat(config.apiFormat)
        switch format {
        case "openai-compatible":
            if provider == "openai" { return AgenticOpenAINativeProvider() }
            if provider == "gemini" { return AgenticGeminiProvider() }
            if provider == "openrouter" {
                let model = config.model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if model == "openrouter/auto" {
                    return AgenticFailingProvider(message: "OpenRouter Auto Router is disabled for Device Agent reviews. Choose a specific OpenRouter model.")
                }
                if model.hasPrefix("anthropic/") { return AgenticAnthropicProvider() }
                if model.hasPrefix("openai/") { return AgenticOpenAINativeProvider() }
                if model.hasPrefix("google/") || model.contains("gemini") {
                    return AgenticFailingProvider(message: "OpenRouter Gemini models are disabled for Device Agent reviews. Use the direct Gemini provider.")
                }
            }
            return AgenticOpenAICompatibleProvider()
        case "anthropic":
            return AgenticAnthropicProvider()
        default:
            return AgenticOpenAICompatibleProvider()
        }
    }
}

final class AgenticFailingProvider: AgenticAgentProvider {
    private let message: String

    init(message: String) {
        self.message = message
    }

    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        completion(.failure(AgenticAgentError(code: "INVALID_CONFIG", subcode: "UNSUPPORTED_MODEL", message: message)))
    }
}

// MARK: - Anthropic provider

final class AgenticAnthropicProvider: AgenticAgentProvider {
    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        guard let apiKey = request.config.apiKey, !apiKey.isEmpty else {
            completion(.failure(AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_API_KEY", message: "Anthropic provider requires an API key.")))
            return
        }

        if request.method == "reviewPlan", AgenticAgentProviderSupport.researchNeeded(request.payload) {
            runResearchPass(request: request, apiKey: apiKey) { research in
                let reviewPayload: [String: Any]
                switch research {
                case .success(let evidence):
                    reviewPayload = AgenticAgentProviderSupport.reviewPayloadWithResearch(request.payload, evidence: evidence)
                case .failure(let err):
                    request.emitDebug(step: "research_fallback", [
                        "code": err.code,
                        "subcode": err.subcode ?? "",
                        "message": err.message,
                    ])
                    reviewPayload = AgenticAgentProviderSupport.reviewPayloadAfterResearchAttempt(request.payload)
                }
                let reviewRequest = AgenticAgentRequest(
                    requestId: request.requestId,
                    method: request.method,
                    systemPrompt: request.systemPrompt,
                    userInstruction: request.userInstruction,
                    context: reviewPayload["context"],
                    payload: reviewPayload,
                    payloadBytes: request.payloadBytes,
                    config: request.config
                )
                self.executeWithoutResearch(request: reviewRequest, apiKey: apiKey, completion: completion)
            }
            return
        }

        executeWithoutResearch(request: request, apiKey: apiKey, completion: completion)
    }

    private func executeWithoutResearch(
        request: AgenticAgentRequest,
        apiKey: String,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let messages = AgenticAgentProviderSupport.messages(for: request)
        postMessages(messages: messages, request: request, apiKey: apiKey, research: request.method == "ask" && AgenticAgentProviderSupport.researchNeeded(request.payload)) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let json):
                let text = AgenticProviderResponseParser.extractAnthropicText(json)
                let parsed = AgenticAgentProviderSupport.parseProviderResult(method: request.method, provider: "anthropic", text: text, raw: json, payload: request.payload)
                if case .failure(let err) = parsed {
                    request.emitDebug(step: "parse_fail", [
                        "code": err.code,
                        "subcode": err.subcode ?? "",
                        "message": err.message,
                    ])
                } else if case .success(let value) = parsed, AgenticAgentProviderSupport.isMalformedReview(value) {
                    request.emitDebug(step: "malformed_review", AgenticAgentProviderSupport.malformedReviewDebugFields(provider: "anthropic", text: text, raw: json))
                }
                completion(parsed)
            }
        }
    }

    private func runResearchPass(
        request: AgenticAgentRequest,
        apiKey: String,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let messages = AgenticDeviceAgentMessageAssembler.buildResearchMessages(
            request.payload,
            researchTargets: AgenticAgentProviderSupport.researchTargets(request.payload)
        )
        postMessages(messages: messages, request: request, apiKey: apiKey, research: true) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let json):
                let summary = AgenticProviderResponseParser.extractAnthropicText(json).trimmingCharacters(in: .whitespacesAndNewlines)
                completion(.success(AgenticAgentProviderSupport.researchEvidence(
                    provider: "Anthropic",
                    summary: summary,
                    raw: json,
                    instructionText: AgenticAgentProviderSupport.instructionText(request.payload)
                )))
            }
        }
    }

    private func postMessages(
        messages: AgenticDeviceAgentMessages,
        request: AgenticAgentRequest,
        apiKey: String,
        research: Bool,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let endpoint = normalizedEndpoint(request.config)
        guard let url = URL(string: endpoint) else {
            completion(.failure(AgenticAgentError(code: "INVALID_URL", message: "Invalid baseUrl: \(endpoint)")))
            return
        }
        let body: [String: Any] = [
            "model": request.config.model,
            "max_tokens": tokenLimit(for: request),
            "system": messages.system,
            "messages": [["role": "user", "content": messages.userContent]],
            "temperature": request.method == "ask" ? 0.3 : 0.2,
        ].merging(research ? ["tools": [webSearchTool(request: request)]] : [:]) { current, _ in current }
        guard let payload = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            completion(.failure(AgenticAgentError(code: "ENCODE_ERROR", message: "Could not encode Anthropic request body.")))
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if isOpenRouter(config: request.config) {
            req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            req.setValue("enabled", forHTTPHeaderField: "X-OpenRouter-Metadata")
            // OpenRouter attribution headers (optional but recommended). iOS has no browser
            // origin, so a stable app referer is used. Mirrors the TS/Android device agents.
            req.setValue("https://ios-device-agent.local", forHTTPHeaderField: "HTTP-Referer")
            req.setValue("Agentic iOS Device Agent", forHTTPHeaderField: "X-Title")
        } else {
            req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        }
        req.httpBody = payload
        AgenticAgentHttp.execute(req, secret: apiKey, metadata: request.httpLogMetadata(provider: "anthropic", research: research), debugBaseUrl: request.debugBaseUrl) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                guard let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                    request.emitDebug(step: "parse_fail", [
                        "code": "PROVIDER_RESPONSE",
                        "message": "Anthropic response was not JSON.",
                    ])
                    completion(.failure(AgenticAgentError(code: "PROVIDER_RESPONSE", message: "Anthropic response was not JSON.")))
                    return
                }
                completion(.success(json))
            }
        }
    }

    private func normalizedEndpoint(_ config: AgenticAgentRuntimeConfig) -> String {
        let apiFormat = isOpenRouter(config: config) ? "openai-compatible" : "anthropic"
        let base = AgenticProviderHttp.normalizeBaseUrl(config.baseUrl, apiFormat: apiFormat)
        return base.hasSuffix("/messages") ? base : "\(base)/messages"
    }

    private func tokenLimit(for request: AgenticAgentRequest) -> Int {
        if request.method == "ask" { return 800 }
        if request.method == "reviewPlan" { return 1800 }
        return 1024
    }

    private func isOpenRouter(config: AgenticAgentRuntimeConfig) -> Bool {
        return config.provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "openrouter" ||
            config.baseUrl.lowercased().contains("openrouter.ai")
    }

    private func webSearchTool(request: AgenticAgentRequest) -> [String: Any] {
        if isOpenRouter(config: request.config) {
            return [
                "type": "openrouter:web_search",
                "parameters": [
                    "engine": "auto",
                    "max_total_results": AgenticAgentProviderSupport.researchMaxUses(request.payload),
                    "user_location": [
                        "type": "approximate",
                        "country": "US",
                        "timezone": "America/Los_Angeles",
                    ],
                ],
            ]
        }
        return anthropicWebSearchTool(payload: request.payload)
    }

    private func anthropicWebSearchTool(payload: [String: Any]) -> [String: Any] {
        return [
            "type": "web_search_20250305",
            "name": "web_search",
            "max_uses": AgenticAgentProviderSupport.researchMaxUses(payload),
            "user_location": [
                "type": "approximate",
                "country": "US",
                "timezone": "America/Los_Angeles",
            ],
        ]
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

final class AgenticOpenAINativeProvider: AgenticAgentProvider {
    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        guard let apiKey = request.config.apiKey, !apiKey.isEmpty else {
            completion(.failure(AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_API_KEY", message: "OpenAI provider requires an API key.")))
            return
        }
        if request.method == "reviewPlan", AgenticAgentProviderSupport.researchNeeded(request.payload) {
            runResearchPass(request: request, apiKey: apiKey) { research in
                let reviewPayload: [String: Any]
                switch research {
                case .success(let evidence):
                    reviewPayload = AgenticAgentProviderSupport.reviewPayloadWithResearch(request.payload, evidence: evidence)
                case .failure(let err):
                    request.emitDebug(step: "research_fallback", [
                        "code": err.code,
                        "subcode": err.subcode ?? "",
                        "message": err.message,
                    ])
                    reviewPayload = AgenticAgentProviderSupport.reviewPayloadAfterResearchAttempt(request.payload)
                }
                let reviewRequest = AgenticAgentRequest(
                    requestId: request.requestId,
                    method: request.method,
                    systemPrompt: request.systemPrompt,
                    userInstruction: request.userInstruction,
                    context: reviewPayload["context"],
                    payload: reviewPayload,
                    payloadBytes: request.payloadBytes,
                    config: request.config
                )
                self.executeWithoutResearch(request: reviewRequest, apiKey: apiKey, completion: completion)
            }
            return
        }
        executeWithoutResearch(request: request, apiKey: apiKey, completion: completion)
    }

    private func executeWithoutResearch(
        request: AgenticAgentRequest,
        apiKey: String,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let messages = AgenticAgentProviderSupport.messages(for: request)
        postResponses(
            messages: messages,
            request: request,
            apiKey: apiKey,
            jsonSchema: request.method == "ask" ? nil : schema(for: request.method),
            research: request.method == "ask" && AgenticAgentProviderSupport.researchNeeded(request.payload)
        ) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let json):
                let text = AgenticProviderResponseParser.extractResponsesApiText(json)
                let parsed = AgenticAgentProviderSupport.parseProviderResult(method: request.method, provider: "openai", text: text, raw: json, payload: request.payload)
                if case .failure(let err) = parsed {
                    request.emitDebug(step: "parse_fail", [
                        "code": err.code,
                        "subcode": err.subcode ?? "",
                        "message": err.message,
                    ])
                } else if case .success(let value) = parsed, AgenticAgentProviderSupport.isMalformedReview(value) {
                    request.emitDebug(step: "malformed_review", AgenticAgentProviderSupport.malformedReviewDebugFields(provider: "openai", text: text, raw: json))
                }
                completion(parsed)
            }
        }
    }

    private func runResearchPass(
        request: AgenticAgentRequest,
        apiKey: String,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let messages = AgenticDeviceAgentMessageAssembler.buildResearchMessages(
            request.payload,
            researchTargets: AgenticAgentProviderSupport.researchTargets(request.payload)
        )
        postResponses(messages: messages, request: request, apiKey: apiKey, jsonSchema: nil, research: true) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let json):
                let summary = AgenticProviderResponseParser.extractResponsesApiText(json).trimmingCharacters(in: .whitespacesAndNewlines)
                completion(.success(AgenticAgentProviderSupport.researchEvidence(
                    provider: "OpenAI",
                    summary: summary,
                    raw: json,
                    instructionText: AgenticAgentProviderSupport.instructionText(request.payload)
                )))
            }
        }
    }

    private func postResponses(
        messages: AgenticDeviceAgentMessages,
        request: AgenticAgentRequest,
        apiKey: String,
        jsonSchema: [String: Any]?,
        research: Bool,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let endpoint = normalizedEndpoint(request.config.baseUrl)
        guard let url = URL(string: endpoint) else {
            completion(.failure(AgenticAgentError(code: "INVALID_URL", message: "Invalid baseUrl: \(endpoint)")))
            return
        }
        var body: [String: Any] = [
            "model": request.config.model,
            "instructions": messages.system,
            "input": messages.userContent,
            "max_output_tokens": request.method == "ask" ? 800 : (research || request.method == "reviewPlan" ? 1800 : 1024),
            "store": false,
        ]
        if let jsonSchema {
            body["text"] = [
                "verbosity": textVerbosity(for: request.method),
                "format": [
                    "type": "json_schema",
                    "name": request.method == "generatePlan" ? "agentic_device_plan" : "agentic_device_review",
                    "strict": request.method == "generatePlan",
                    "schema": jsonSchema,
                ],
            ]
        }
        if !AgenticProviderHttp.isReasoningModel(request.config.model) {
            body["temperature"] = request.method == "ask" ? 0.3 : 0.2
        } else {
            body["reasoning"] = ["effort": "low"]
        }
        if research {
            body["tools"] = [webSearchTool(config: request.config)]
            body["tool_choice"] = "auto"
            if !isOpenRouter(config: request.config) {
                body["include"] = ["web_search_call.action.sources"]
            }
        }
        guard let payload = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            completion(.failure(AgenticAgentError(code: "ENCODE_ERROR", message: "Could not encode OpenAI Responses request body.")))
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        if isOpenRouter(config: request.config) {
            req.setValue("enabled", forHTTPHeaderField: "X-OpenRouter-Metadata")
            // OpenRouter attribution headers (optional but recommended). iOS has no browser
            // origin, so a stable app referer is used. Mirrors the TS/Android device agents.
            req.setValue("https://ios-device-agent.local", forHTTPHeaderField: "HTTP-Referer")
            req.setValue("Agentic iOS Device Agent", forHTTPHeaderField: "X-Title")
        }
        req.httpBody = payload
        AgenticAgentHttp.execute(req, secret: apiKey, metadata: request.httpLogMetadata(provider: "openai", research: research), debugBaseUrl: request.debugBaseUrl) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let data):
                guard let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                    request.emitDebug(step: "parse_fail", [
                        "code": "PROVIDER_RESPONSE",
                        "message": "OpenAI response was not JSON.",
                    ])
                    completion(.failure(AgenticAgentError(code: "PROVIDER_RESPONSE", message: "OpenAI response was not JSON.")))
                    return
                }
                completion(.success(json))
            }
        }
    }

    private func normalizedEndpoint(_ raw: String?) -> String {
        let base = AgenticProviderHttp.normalizeBaseUrl(raw, apiFormat: "openai-compatible")
        if base.hasSuffix("/responses") { return base }
        if base.hasSuffix("/chat/completions") {
            return String(base.dropLast("/chat/completions".count)) + "/responses"
        }
        return "\(base)/responses"
    }

    private func isOpenRouter(config: AgenticAgentRuntimeConfig) -> Bool {
        return config.provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "openrouter" ||
            config.baseUrl.lowercased().contains("openrouter.ai")
    }

    private func webSearchTool(config: AgenticAgentRuntimeConfig) -> [String: Any] {
        if isOpenRouter(config: config) {
            return [
                "type": "openrouter:web_search",
                "parameters": [
                    "engine": "auto",
                    "max_total_results": 3,
                    "user_location": [
                        "type": "approximate",
                        "country": "US",
                        "timezone": "America/Los_Angeles",
                    ],
                ],
            ]
        }
        return [
            "type": "web_search_preview",
            "user_location": [
                "type": "approximate",
                "country": "US",
                "timezone": "America/Los_Angeles",
            ],
        ]
    }

    private func schema(for method: String) -> [String: Any] {
        if method == "generatePlan" {
            return [
                "type": "object",
                "additionalProperties": false,
                "properties": [
                    "intent": ["type": "string"],
                    "route": ["type": "string"],
                    "risk": ["type": "string"],
                    "approval": ["type": "string"],
                    "safeguards": ["type": "array", "items": ["type": "string"]],
                ],
                "required": ["intent", "route", "risk", "approval", "safeguards"],
            ]
        }
        let decisionEnum = ["approve", "deny", "needs_input"]
        let inputKindEnum = ["text", "select", "number"]
        let reviewerIdEnum = ["risk", "quote", "policy", "protocol"]
        let stringArraySchema: [String: Any] = [
            "type": "array",
            "items": ["type": "string"],
        ]
        let findingSchema: [String: Any] = [
            "type": "object",
            "additionalProperties": true,
            "properties": [
                "label": ["type": "string"],
                "value": ["type": "string"],
                "tone": ["type": "string", "enum": ["good", "warn", "neutral", "fail"]],
            ],
            "required": ["label", "value", "tone"],
        ]
        let sourceSchema: [String: Any] = [
            "type": "object",
            "additionalProperties": true,
            "properties": [
                "title": ["type": "string"],
                "url": ["type": "string"],
            ],
            "required": ["url"],
        ]
        return [
            "type": "object",
            "additionalProperties": false,
            "properties": [
                "decision": ["type": "string", "enum": decisionEnum],
                "reason": ["type": "string"],
                "summary": ["type": "string"],
                "evidence": [
                    "type": "object",
                    "additionalProperties": true,
                    "properties": [
                        "findings": ["type": "array", "items": findingSchema],
                        "sources": ["type": "array", "items": sourceSchema],
                        "research": [
                            "type": "object",
                            "additionalProperties": true,
                            "properties": [
                                "status": ["type": "string"],
                            ],
                        ],
                        "policiesApplied": stringArraySchema,
                    ],
                ],
                "questions": [
                    "type": "array",
                    "maxItems": 3,
                    "items": [
                        "type": "object",
                        "additionalProperties": false,
                        "properties": [
                            "id": ["type": "string"],
                            "prompt": ["type": "string"],
                            "inputKind": ["type": "string", "enum": inputKindEnum],
                            "options": ["type": "array", "items": ["type": "string"]],
                            "required": ["type": "boolean"],
                            "hint": ["type": "string"],
                        ],
                        "required": ["id", "prompt", "inputKind"],
                    ],
                ],
                "reviewers": [
                    "type": "array",
                    "maxItems": 4,
                    "items": [
                        "type": "object",
                        "additionalProperties": false,
                        "properties": [
                            "id": ["type": "string", "enum": reviewerIdEnum],
                            "decision": ["type": "string", "enum": decisionEnum],
                            "reason": ["type": "string"],
                            "summary": ["type": "string"],
                        ],
                        "required": ["id", "decision", "reason"],
                    ],
                ],
                "evidenceFactIds": stringArraySchema,
                "blockingFactIds": stringArraySchema,
                "missingFactIds": stringArraySchema,
                "confidence": ["type": "string", "enum": ["high", "medium", "low"]],
            ],
            "required": ["decision", "reason", "summary", "evidence"],
        ]
    }

    private func textVerbosity(for method: String) -> String {
        return method == "reviewPlan" ? "medium" : "low"
    }

    private static func extractText(_ json: [String: Any]) -> String {
        if let text = json["output_text"] as? String { return text }
        guard let output = json["output"] as? [[String: Any]] else { return "" }
        var parts: [String] = []
        for item in output {
            guard let content = item["content"] as? [[String: Any]] else { continue }
            for block in content {
                if let text = block["text"] as? String { parts.append(text) }
            }
        }
        return parts.joined(separator: "\n")
    }
}

final class AgenticOpenAICompatibleProvider: AgenticAgentProvider {
    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        guard let apiKey = request.config.apiKey, !apiKey.isEmpty else {
            completion(.failure(AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_API_KEY", message: "OpenAI-compatible provider requires an API key.")))
            return
        }
        if AgenticAgentProviderSupport.researchNeeded(request.payload) {
            if request.method == "reviewPlan" {
                completion(.success(AgenticAgentProviderSupport.currentResearchUnavailableReview(provider: request.config.provider)))
            } else if request.method == "ask" {
                completion(.success(AgenticAgentProviderSupport.currentResearchUnavailableAsk(provider: request.config.provider)))
            } else {
                postChatCompletion(request: request, apiKey: apiKey, completion: completion)
            }
            return
        }
        postChatCompletion(request: request, apiKey: apiKey, completion: completion)
    }

    private func postChatCompletion(
        request: AgenticAgentRequest,
        apiKey: String,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let endpoint = normalizedEndpoint(request.config.baseUrl)
        guard let url = URL(string: endpoint) else {
            completion(.failure(AgenticAgentError(code: "INVALID_URL", message: "Invalid baseUrl: \(endpoint)")))
            return
        }
        let messages = AgenticAgentProviderSupport.messages(for: request)
        var body: [String: Any] = [
            "model": request.config.model,
            "messages": [
                ["role": "system", "content": messages.system],
                ["role": "user", "content": messages.userContent],
            ],
        ]
        body[AgenticProviderHttp.tokenLimitKey(request.config.model)] = request.method == "ask" ? 800 : 1024
        if !AgenticProviderHttp.isDefaultTemperatureOnlyModel(request.config.model) {
            body["temperature"] = request.method == "ask" ? 0.3 : 0.2
        }
        if request.method != "ask" {
            body["response_format"] = ["type": "json_object"]
        }
        guard let payload = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            completion(.failure(AgenticAgentError(code: "ENCODE_ERROR", message: "Could not encode request body.")))
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = payload
        AgenticAgentHttp.execute(req, secret: apiKey, metadata: request.httpLogMetadata(provider: request.config.provider, research: false), debugBaseUrl: request.debugBaseUrl) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                guard let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                    request.emitDebug(step: "parse_fail", [
                        "code": "PROVIDER_RESPONSE",
                        "message": "OpenAI response was not JSON.",
                    ])
                    completion(.failure(AgenticAgentError(code: "PROVIDER_RESPONSE", message: "OpenAI response was not JSON.")))
                    return
                }
                let text = Self.extractText(json) ?? ""
                let parsed = AgenticAgentProviderSupport.parseProviderResult(method: request.method, provider: request.config.provider, text: text, raw: json, payload: request.payload)
                if case .failure(let err) = parsed {
                    request.emitDebug(step: "parse_fail", [
                        "code": err.code,
                        "subcode": err.subcode ?? "",
                        "message": err.message,
                    ])
                } else if case .success(let value) = parsed, AgenticAgentProviderSupport.isMalformedReview(value) {
                    request.emitDebug(step: "malformed_review", AgenticAgentProviderSupport.malformedReviewDebugFields(provider: request.config.provider, text: text, raw: json))
                }
                completion(parsed)
            }
        }
    }

    private func normalizedEndpoint(_ raw: String?) -> String {
        let base = AgenticProviderHttp.normalizeBaseUrl(raw, apiFormat: "openai-compatible")
        return base.hasSuffix("/chat/completions") ? base : "\(base)/chat/completions"
    }

    private static func extractText(_ json: [String: Any]) -> String? {
        guard let choices = json["choices"] as? [[String: Any]],
              let first = choices.first,
              let message = first["message"] as? [String: Any],
              let content = message["content"] as? String else { return nil }
        return content
    }
}

// MARK: - Gemini native provider

final class AgenticGeminiProvider: AgenticAgentProvider {
    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        guard let apiKey = request.config.apiKey, !apiKey.isEmpty else {
            completion(.failure(AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_API_KEY", message: "Gemini provider requires an API key.")))
            return
        }
        if request.method == "reviewPlan", AgenticAgentProviderSupport.researchNeeded(request.payload) {
            runResearchPass(request: request, apiKey: apiKey) { research in
                let reviewPayload: [String: Any]
                switch research {
                case .success(let evidence):
                    reviewPayload = AgenticAgentProviderSupport.reviewPayloadWithResearch(request.payload, evidence: evidence)
                case .failure(let err):
                    request.emitDebug(step: "research_fallback", [
                        "code": err.code,
                        "subcode": err.subcode ?? "",
                        "message": err.message,
                    ])
                    reviewPayload = AgenticAgentProviderSupport.reviewPayloadAfterResearchAttempt(request.payload)
                }
                let reviewRequest = AgenticAgentRequest(
                    requestId: request.requestId,
                    method: request.method,
                    systemPrompt: request.systemPrompt,
                    userInstruction: request.userInstruction,
                    context: reviewPayload["context"],
                    payload: reviewPayload,
                    payloadBytes: request.payloadBytes,
                    config: request.config
                )
                self.executeWithoutResearch(request: reviewRequest, apiKey: apiKey, completion: completion)
            }
            return
        }
        executeWithoutResearch(request: request, apiKey: apiKey, completion: completion)
    }

    private func executeWithoutResearch(
        request: AgenticAgentRequest,
        apiKey: String,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let messages = AgenticAgentProviderSupport.messages(for: request)
        postGenerateContent(
            messages: messages,
            request: request,
            apiKey: apiKey,
            jsonObjectMode: request.method != "ask",
            research: request.method == "ask" && AgenticAgentProviderSupport.researchNeeded(request.payload)
        ) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let json):
                let text = AgenticProviderResponseParser.extractGeminiText(json)
                let parsed = AgenticAgentProviderSupport.parseProviderResult(method: request.method, provider: "gemini", text: text, raw: json, payload: request.payload)
                if case .failure(let err) = parsed {
                    request.emitDebug(step: "parse_fail", [
                        "code": err.code,
                        "subcode": err.subcode ?? "",
                        "message": err.message,
                    ])
                } else if case .success(let value) = parsed, AgenticAgentProviderSupport.isMalformedReview(value) {
                    request.emitDebug(step: "malformed_review", AgenticAgentProviderSupport.malformedReviewDebugFields(provider: "gemini", text: text, raw: json))
                }
                completion(parsed)
            }
        }
    }

    private func runResearchPass(
        request: AgenticAgentRequest,
        apiKey: String,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        let messages = AgenticDeviceAgentMessageAssembler.buildResearchMessages(
            request.payload,
            researchTargets: AgenticAgentProviderSupport.researchTargets(request.payload)
        )
        postGenerateContent(messages: messages, request: request, apiKey: apiKey, jsonObjectMode: false, research: true) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let json):
                let summary = AgenticProviderResponseParser.extractGeminiText(json).trimmingCharacters(in: .whitespacesAndNewlines)
                completion(.success(AgenticAgentProviderSupport.researchEvidence(
                    provider: "Gemini",
                    summary: summary,
                    raw: json,
                    instructionText: AgenticAgentProviderSupport.instructionText(request.payload)
                )))
            }
        }
    }

    private func postGenerateContent(
        messages: AgenticDeviceAgentMessages,
        request: AgenticAgentRequest,
        apiKey: String,
        jsonObjectMode: Bool,
        research: Bool,
        completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void
    ) {
        guard let url = endpointURL(config: request.config) else {
            completion(.failure(AgenticAgentError(code: "INVALID_URL", message: "Invalid Gemini baseUrl.")))
            return
        }
        var generationConfig: [String: Any] = [
            "temperature": request.method == "ask" ? 0.3 : 0.2,
            "maxOutputTokens": request.method == "ask" ? 800 : (research ? 1800 : (request.method == "reviewPlan" ? 1800 : 1024)),
        ]
        if jsonObjectMode && !research {
            generationConfig["responseMimeType"] = "application/json"
            generationConfig["responseSchema"] = schema(for: request.method)
        }
        var body: [String: Any] = [
            "systemInstruction": [
                "parts": [["text": messages.system]],
            ],
            "contents": [[
                "role": "user",
                "parts": [["text": messages.userContent]],
            ]],
            "generationConfig": generationConfig,
        ]
        if research {
            body["tools"] = [["google_search": [String: Any]()] as [String: Any]]
        }
        guard let payload = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            completion(.failure(AgenticAgentError(code: "ENCODE_ERROR", message: "Could not encode Gemini request body.")))
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        req.httpBody = payload
        AgenticAgentHttp.execute(req, secret: apiKey, metadata: request.httpLogMetadata(provider: "gemini", research: research), debugBaseUrl: request.debugBaseUrl) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let data):
                guard let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                    request.emitDebug(step: "parse_fail", [
                        "code": "PROVIDER_RESPONSE",
                        "message": "Gemini response was not JSON.",
                    ])
                    completion(.failure(AgenticAgentError(code: "PROVIDER_RESPONSE", message: "Gemini response was not JSON.")))
                    return
                }
                completion(.success(json))
            }
        }
    }

    private func endpointURL(config: AgenticAgentRuntimeConfig) -> URL? {
        let nativeBase = AgenticProviderHttp.normalizeNativeBaseUrl(config.baseUrl)
        if nativeBase.contains("/models/") && nativeBase.hasSuffix(":generateContent") {
            return URL(string: nativeBase)
        }
        if nativeBase.contains("/models/") {
            return URL(string: "\(nativeBase):generateContent")
        }
        let encodedModel = config.model.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? config.model
        return URL(string: "\(nativeBase)/models/\(encodedModel):generateContent")
    }

    private func schema(for method: String) -> [String: Any] {
        let stringArraySchema: [String: Any] = [
            "type": "array",
            "items": ["type": "string"],
        ]
        if method == "generatePlan" {
            return [
                "type": "object",
                "properties": [
                    "intent": ["type": "string"],
                    "route": ["type": "string"],
                    "risk": ["type": "string"],
                    "approval": ["type": "string"],
                    "safeguards": stringArraySchema,
                ],
                "required": ["intent", "route", "risk", "approval", "safeguards"],
                "propertyOrdering": ["intent", "route", "risk", "approval", "safeguards"],
            ]
        }
        let decisionEnum = ["approve", "deny", "needs_input"]
        let inputKindEnum = ["text", "select", "number"]
        let reviewerIdEnum = ["risk", "quote", "policy", "protocol"]
        let findingSchema: [String: Any] = [
            "type": "object",
            "properties": [
                "label": ["type": "string"],
                "value": ["type": "string"],
                "tone": ["type": "string", "enum": ["good", "warn", "neutral", "fail"]],
            ],
            "required": ["label", "value", "tone"],
            "propertyOrdering": ["label", "value", "tone"],
        ]
        let sourceSchema: [String: Any] = [
            "type": "object",
            "properties": [
                "title": ["type": "string"],
                "url": ["type": "string"],
            ],
            "required": ["url"],
            "propertyOrdering": ["title", "url"],
        ]
        let questionSchema: [String: Any] = [
            "type": "object",
            "properties": [
                "id": ["type": "string"],
                "prompt": ["type": "string"],
                "inputKind": ["type": "string", "enum": inputKindEnum],
                "options": stringArraySchema,
                "required": ["type": "boolean"],
                "hint": ["type": "string"],
            ],
            "required": ["id", "prompt", "inputKind"],
            "propertyOrdering": ["id", "prompt", "inputKind", "options", "required", "hint"],
        ]
        let reviewerSchema: [String: Any] = [
            "type": "object",
            "properties": [
                "id": ["type": "string", "enum": reviewerIdEnum],
                "decision": ["type": "string", "enum": decisionEnum],
                "reason": ["type": "string"],
                "summary": ["type": "string"],
            ],
            "required": ["id", "decision", "reason"],
            "propertyOrdering": ["id", "decision", "reason", "summary"],
        ]
        return [
            "type": "object",
            "properties": [
                "decision": ["type": "string", "enum": decisionEnum],
                "reason": ["type": "string"],
                "summary": ["type": "string"],
                "evidence": [
                    "type": "object",
                    "properties": [
                        "findings": ["type": "array", "items": findingSchema],
                        "sources": ["type": "array", "items": sourceSchema],
                        "research": [
                            "type": "object",
                            "properties": [
                                "status": ["type": "string"],
                            ],
                        ],
                        "policiesApplied": stringArraySchema,
                    ],
                    "propertyOrdering": ["findings", "sources", "research", "policiesApplied"],
                ],
                "questions": ["type": "array", "maxItems": 3, "items": questionSchema],
                "reviewers": ["type": "array", "maxItems": 4, "items": reviewerSchema],
                "evidenceFactIds": stringArraySchema,
                "blockingFactIds": stringArraySchema,
                "missingFactIds": stringArraySchema,
                "confidence": ["type": "string", "enum": ["high", "medium", "low"]],
            ],
            "required": ["decision", "reason", "summary", "evidence"],
            "propertyOrdering": [
                "decision",
                "reason",
                "summary",
                "evidence",
                "questions",
                "reviewers",
                "evidenceFactIds",
                "blockingFactIds",
                "missingFactIds",
                "confidence",
            ],
        ]
    }

    private static func extractText(_ json: [String: Any]) -> String? {
        guard let candidates = json["candidates"] as? [[String: Any]] else { return nil }
        let parts = candidates.compactMap { candidate -> String? in
            guard let content = candidate["content"] as? [String: Any],
                  let parts = content["parts"] as? [[String: Any]] else {
                return nil
            }
            return parts.compactMap { $0["text"] as? String }.joined()
        }
        return parts.joined(separator: "\n")
    }
}

// MARK: - HTTP helper

enum AgenticAgentHttp {
    static func execute(
        _ request: URLRequest,
        secret: String?,
        metadata: [String: String] = [:],
        debugBaseUrl: String? = nil,
        completion: @escaping (Result<Data, AgenticAgentError>) -> Void
    ) {
        let startedAt = Date()
        let session = URLSession(configuration: .ephemeral)
        var startMetadata = metadata
        startMetadata["host"] = request.url?.host ?? ""
        AgenticIOSLog.info("AgenticDeviceAgentHTTP", request.httpMethod ?? "HTTP", "START", "provider HTTP request started", startMetadata)
        emitDebug(baseUrl: debugBaseUrl, step: "http_start", metadata: startMetadata)
        let task = session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }
            let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            var logMetadata = metadata
            logMetadata["durationMs"] = String(durationMs)
            logMetadata["host"] = request.url?.host ?? ""
            if let error {
                let nsError = error as NSError
                let code = nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut
                    ? AgenticProviderErrorCodes.timeout
                    : AgenticProviderErrorCodes.network
                let redacted = AgenticSecretRedactor.redact(error.localizedDescription, secret: secret)
                logMetadata["code"] = code
                logMetadata["errorDomain"] = nsError.domain
                logMetadata["errorCode"] = String(nsError.code)
                AgenticIOSLog.fail("AgenticDeviceAgentHTTP", request.httpMethod ?? "HTTP", "FAIL", "provider HTTP request failed", logMetadata)
                emitDebug(baseUrl: debugBaseUrl, step: "http_fail", metadata: logMetadata)
                completion(.failure(AgenticAgentError(code: code, message: redacted)))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                logMetadata["code"] = AgenticProviderErrorCodes.network
                AgenticIOSLog.fail("AgenticDeviceAgentHTTP", request.httpMethod ?? "HTTP", "FAIL", "provider returned no HTTP response", logMetadata)
                emitDebug(baseUrl: debugBaseUrl, step: "http_fail", metadata: logMetadata)
                completion(.failure(AgenticAgentError(code: AgenticProviderErrorCodes.network, message: "No HTTP response from AI provider.")))
                return
            }
            logMetadata["statusCode"] = String(http.statusCode)
            let responseData = data ?? Data()
            logMetadata["responseBytes"] = String(responseData.count)
            if let errorCode = AgenticProviderHttp.mapHttpStatusToErrorCode(http.statusCode) {
                let bodyString = String(data: responseData, encoding: .utf8) ?? ""
                let redacted = AgenticSecretRedactor.redact(bodyString, secret: secret)
                logMetadata["code"] = errorCode
                AgenticIOSLog.fail("AgenticDeviceAgentHTTP", request.httpMethod ?? "HTTP", "FAIL", "provider HTTP status failed", logMetadata)
                emitDebug(baseUrl: debugBaseUrl, step: "http_fail", metadata: logMetadata)
                completion(.failure(AgenticAgentError(
                    code: errorCode,
                    message: AgenticProviderHttp.composeErrorMessage(status: http.statusCode, body: String(redacted.prefix(1000)))
                )))
                return
            }
            logMetadata["bytes"] = String(responseData.count)
            AgenticIOSLog.info("AgenticDeviceAgentHTTP", request.httpMethod ?? "HTTP", "SUCCESS", "provider HTTP request completed", logMetadata)
            emitDebug(baseUrl: debugBaseUrl, step: "http_success", metadata: logMetadata)
            completion(.success(responseData))
        }
        task.resume()
    }

    private static func emitDebug(baseUrl: String?, step: String, metadata: [String: String]) {
        AgenticDeviceAgentDebugTelemetry.emit(baseUrl: baseUrl, fields: [
            "method": metadata["method"] ?? "unknown",
            "requestId": metadata["requestId"] ?? "",
            "runtime": "ios-native",
            "provider": metadata["provider"] ?? "",
            "model": metadata["model"] ?? "",
            "step": step,
            "durationMs": metadata["durationMs"] ?? "",
            "statusCode": metadata["statusCode"] ?? "",
            "code": metadata["code"] ?? "",
            "httpHost": metadata["host"] ?? "",
            "responseBytes": metadata["responseBytes"] ?? metadata["bytes"] ?? "",
            "errorDomain": metadata["errorDomain"] ?? "",
            "errorCode": metadata["errorCode"] ?? "",
        ])
    }
}
