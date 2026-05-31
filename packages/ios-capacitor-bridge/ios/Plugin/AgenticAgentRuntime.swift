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
    private var id = UIBackgroundTaskIdentifier.invalid
    private var ended = false

    init(name: String) {
        self.name = name
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

        // Background task gives the provider a short completion window if the
        // app backgrounds mid-request. The token is main-thread-owned.
        let backgroundTask = AgenticBackgroundTask(name: "agentic-device-agent-\(method)")
        backgroundTask.begin()

        let request = AgenticAgentRequest(
            method: method,
            systemPrompt: systemPrompt,
            userInstruction: userInstruction,
            context: context,
            payload: payload,
            config: cfg
        )

        provider.execute(request: request) { [weak self] result in
            backgroundTask.end()
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
    let method: String
    let systemPrompt: String
    let userInstruction: String
    let context: Any?
    let payload: [String: Any]
    let config: AgenticAgentRuntimeConfig
}

struct AgenticDeviceAgentMessages {
    let system: String
    let userContent: String
}

enum AgenticDeviceAgentBoundaries {
    static let plan = "Return JSON only. Do not sign, submit, approve, or claim execution."
    static let review = "This AI review can approve, deny, or request more input. It cannot sign or submit a transaction."
    static let ask = "Answer only the user's question. Do not sign, submit, approve, or claim execution."
    static let reviewDefaultInstruction = "Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input."
}

enum AgenticDeviceAgentMessageAssembler {
    private static let researchMaxUses = 3
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
                "maxSearches": researchMaxUses,
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
            "maxSearches": researchMaxUses,
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

    static func parseProviderResult(method: String, provider: String, text: String, raw: [String: Any]) -> Result<[String: Any], AgenticAgentError> {
        if method == "ask" {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return .failure(AgenticAgentError(code: "PROVIDER_RESPONSE", subcode: "EMPTY_TEXT", message: "Provider response had no answer text."))
            }
            return .success(["output_text": text])
        }
        guard let parsed = AgenticProviderResponseParser.parseModelJson(text) else {
            return .failure(AgenticAgentError(code: "PROVIDER_RESPONSE", subcode: "JSON_PARSE", message: "Provider response was not valid JSON."))
        }
        var out = parsed
        out["provider"] = provider
        return .success(out)
    }

    static func researchNeeded(_ payload: [String: Any]) -> Bool {
        guard let research = payload["research"] as? [String: Any] else { return false }
        return (research["needed"] as? Bool) == true
    }

    static func researchTargets(_ payload: [String: Any]) -> [[String: Any]] {
        guard let context = payload["context"] as? [String: Any],
              let targets = context["researchTargets"] as? [[String: Any]] else { return [] }
        return targets
    }

    static func reviewPayloadWithResearch(_ payload: [String: Any], evidence: [String: Any]) -> [String: Any] {
        var next = payload
        var context = payload["context"] as? [String: Any] ?? [:]
        context["researchEvidence"] = evidence
        next["context"] = context
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
        ]
    }

    static func currentResearchUnavailableAsk(provider: String) -> [String: Any] {
        return ["output_text": "I need current outside facts to answer that, but \(provider) mode does not have native web research available. Provide a source-backed value or switch to OpenAI, Anthropic, or Gemini."]
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
        if config.provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "openai" {
            return AgenticOpenAINativeProvider()
        }
        if config.provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "gemini" ||
            (config.baseUrl ?? "").lowercased().contains("generativelanguage.googleapis.com") ||
            config.model.lowercased().contains("gemini") {
            return AgenticGeminiProvider()
        }
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
    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        guard let apiKey = request.config.apiKey, !apiKey.isEmpty else {
            completion(.failure(AgenticAgentError(code: "INVALID_CONFIG", subcode: "MISSING_API_KEY", message: "Anthropic provider requires an API key.")))
            return
        }

        if request.method == "reviewPlan", AgenticAgentProviderSupport.researchNeeded(request.payload) {
            runResearchPass(request: request, apiKey: apiKey) { [weak self] research in
                guard let self else { return }
                let reviewPayload: [String: Any]
                switch research {
                case .success(let evidence):
                    reviewPayload = AgenticAgentProviderSupport.reviewPayloadWithResearch(request.payload, evidence: evidence)
                case .failure(let err):
                    completion(.success(AgenticAgentProviderSupport.currentResearchFailedReview(provider: "Anthropic", error: err)))
                    return
                }
                let reviewRequest = AgenticAgentRequest(
                    method: request.method,
                    systemPrompt: request.systemPrompt,
                    userInstruction: request.userInstruction,
                    context: reviewPayload["context"],
                    payload: reviewPayload,
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
                completion(AgenticAgentProviderSupport.parseProviderResult(method: request.method, provider: "anthropic", text: text, raw: json))
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
        let endpoint = normalizedEndpoint(request.config.baseUrl)
        guard let url = URL(string: endpoint) else {
            completion(.failure(AgenticAgentError(code: "INVALID_URL", message: "Invalid baseUrl: \(endpoint)")))
            return
        }
        let body: [String: Any] = [
            "model": request.config.model,
            "max_tokens": request.method == "ask" ? 800 : 1024,
            "system": messages.system,
            "messages": [["role": "user", "content": messages.userContent]],
            "temperature": request.method == "ask" ? 0.3 : 0.2,
        ].merging(research ? ["tools": [anthropicWebSearchTool()]] : [:]) { current, _ in current }
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
                completion(.success(json))
            }
        }
    }

    private func normalizedEndpoint(_ raw: String?) -> String {
        let base = AgenticProviderHttp.normalizeBaseUrl(raw, apiFormat: "anthropic")
        return base.hasSuffix("/messages") ? base : "\(base)/messages"
    }

    private func anthropicWebSearchTool() -> [String: Any] {
        return [
            "type": "web_search_20250305",
            "name": "web_search",
            "max_uses": 3,
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
            runResearchPass(request: request, apiKey: apiKey) { [weak self] research in
                guard let self else { return }
                let reviewPayload: [String: Any]
                switch research {
                case .success(let evidence):
                    reviewPayload = AgenticAgentProviderSupport.reviewPayloadWithResearch(request.payload, evidence: evidence)
                case .failure(let err):
                    completion(.success(AgenticAgentProviderSupport.currentResearchFailedReview(provider: "OpenAI", error: err)))
                    return
                }
                let reviewRequest = AgenticAgentRequest(
                    method: request.method,
                    systemPrompt: request.systemPrompt,
                    userInstruction: request.userInstruction,
                    context: reviewPayload["context"],
                    payload: reviewPayload,
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
                completion(AgenticAgentProviderSupport.parseProviderResult(method: request.method, provider: "openai", text: text, raw: json))
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
            "max_output_tokens": request.method == "ask" ? 800 : (research ? 1800 : 1024),
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
            body["tools"] = [[
                "type": "web_search_preview",
                "user_location": [
                    "type": "approximate",
                    "country": "US",
                    "timezone": "America/Los_Angeles",
                ],
            ]]
            body["tool_choice"] = "auto"
            body["include"] = ["web_search_call.action.sources"]
        }
        guard let payload = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            completion(.failure(AgenticAgentError(code: "ENCODE_ERROR", message: "Could not encode OpenAI Responses request body.")))
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = payload
        AgenticAgentHttp.execute(req, secret: apiKey) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let data):
                guard let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
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
        return [
            "type": "object",
            "additionalProperties": true,
            "properties": [
                "decision": ["type": "string", "enum": ["approve", "deny", "needs_input"]],
                "reason": ["type": "string"],
                "summary": ["type": "string"],
                "evidence": ["type": "object", "additionalProperties": true],
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
        AgenticAgentHttp.execute(req, secret: apiKey) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                guard let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                    completion(.failure(AgenticAgentError(code: "PROVIDER_RESPONSE", message: "OpenAI response was not JSON.")))
                    return
                }
                let text = Self.extractText(json) ?? ""
                completion(AgenticAgentProviderSupport.parseProviderResult(method: request.method, provider: request.config.provider, text: text, raw: json))
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
            runResearchPass(request: request, apiKey: apiKey) { [weak self] research in
                guard let self else { return }
                let reviewPayload: [String: Any]
                switch research {
                case .success(let evidence):
                    reviewPayload = AgenticAgentProviderSupport.reviewPayloadWithResearch(request.payload, evidence: evidence)
                case .failure(let err):
                    completion(.success(AgenticAgentProviderSupport.currentResearchFailedReview(provider: "Gemini", error: err)))
                    return
                }
                let reviewRequest = AgenticAgentRequest(
                    method: request.method,
                    systemPrompt: request.systemPrompt,
                    userInstruction: request.userInstruction,
                    context: reviewPayload["context"],
                    payload: reviewPayload,
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
                completion(AgenticAgentProviderSupport.parseProviderResult(method: request.method, provider: "gemini", text: text, raw: json))
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
            "maxOutputTokens": request.method == "ask" ? 800 : (research ? 1800 : 1024),
        ]
        if jsonObjectMode && !research {
            generationConfig["responseMimeType"] = "application/json"
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
        AgenticAgentHttp.execute(req, secret: apiKey) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let data):
                guard let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
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
    static func execute(_ request: URLRequest, secret: String?, completion: @escaping (Result<Data, AgenticAgentError>) -> Void) {
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: request) { data, response, error in
            if let error {
                let nsError = error as NSError
                let code = nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut
                    ? AgenticProviderErrorCodes.timeout
                    : AgenticProviderErrorCodes.network
                let redacted = AgenticSecretRedactor.redact(error.localizedDescription, secret: secret)
                completion(.failure(AgenticAgentError(code: code, message: redacted)))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                completion(.failure(AgenticAgentError(code: AgenticProviderErrorCodes.network, message: "No HTTP response from AI provider.")))
                return
            }
            let responseData = data ?? Data()
            if let errorCode = AgenticProviderHttp.mapHttpStatusToErrorCode(http.statusCode) {
                let bodyString = String(data: responseData, encoding: .utf8) ?? ""
                let redacted = AgenticSecretRedactor.redact(bodyString, secret: secret)
                completion(.failure(AgenticAgentError(
                    code: errorCode,
                    message: AgenticProviderHttp.composeErrorMessage(status: http.statusCode, body: String(redacted.prefix(1000)))
                )))
                return
            }
            completion(.success(responseData))
        }
        task.resume()
    }
}
