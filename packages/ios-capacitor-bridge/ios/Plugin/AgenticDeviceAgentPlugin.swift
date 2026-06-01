import Capacitor
import Foundation

enum AgenticDeviceAgentBridgeEnvelope {
    static let maxConfigPayloadChars = 8_192
    static let maxRequestPayloadChars = 2_000_000

    private static let requestIdPattern = "^[A-Za-z0-9_.:-]{1,160}$"
    private static let supportedMethods: Set<String> = [
        "status",
        "configure",
        "start",
        "stop",
        "generatePlan",
        "reviewPlan",
        "ask",
    ]

    static func isSupportedMethod(_ method: String) -> Bool {
        supportedMethods.contains(method)
    }

    static func isValidRequestId(_ requestId: String) -> Bool {
        requestId.range(of: requestIdPattern, options: .regularExpression) != nil
    }

    static func payloadLimit(for method: String) -> Int {
        method == "configure" || method == "start" ? maxConfigPayloadChars : maxRequestPayloadChars
    }

    static func parsePayloadJson(_ payloadJson: String) throws -> [String: Any] {
        let text = payloadJson.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "{}"
            : payloadJson
        guard let data = text.data(using: .utf8) else {
            throw AgenticAgentError(
                code: "invalid_payload",
                subcode: "utf8",
                message: "Device Agent payloadJson must be UTF-8 text."
            )
        }
        do {
            let decoded = try JSONSerialization.jsonObject(with: data, options: [])
            guard let payload = decoded as? [String: Any] else {
                throw AgenticAgentError(
                    code: "invalid_payload",
                    subcode: "object_expected",
                    message: "Device Agent payloadJson must decode to a JSON object."
                )
            }
            return payload
        } catch let err as AgenticAgentError {
            throw err
        } catch {
            throw AgenticAgentError(
                code: "invalid_payload",
                subcode: "json_parse",
                message: "Device Agent payloadJson is not valid JSON."
            )
        }
    }

    static func success(status: [String: Any], result: [String: Any]? = nil) -> [String: Any] {
        var envelope: [String: Any] = [
            "ok": true,
            "status": status,
        ]
        if let result {
            envelope["result"] = result
        }
        return envelope
    }

    static func failure(status: [String: Any], error: AgenticAgentError) -> [String: Any] {
        [
            "ok": false,
            "status": status,
            "error": error.asJson,
        ]
    }
}

@objc(AgenticDeviceAgentPlugin)
public class AgenticDeviceAgentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticDeviceAgentPlugin"
    public let jsName = "AgenticDeviceAgent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "deviceAgentRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generatePlan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reviewPlan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ask", returnType: CAPPluginReturnPromise),
    ]

    // Backed by AgenticAgentRuntime (Phase 3).
    // Mirrors apps/android-twa/.../agent/AgentRuntimeController.kt.
    //
    // Payload size caps (mirror Android DeviceAgentClient.ts):
    //   - configure/start: 8 KB
    //   - generatePlan/reviewPlan/ask: 2 MB
    private static let maxConfigPayloadChars = AgenticDeviceAgentBridgeEnvelope.maxConfigPayloadChars
    private static let maxRequestPayloadChars = AgenticDeviceAgentBridgeEnvelope.maxRequestPayloadChars

    @objc func status(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        call.resolve(AgenticAgentRuntime.shared.status())
    }

    @objc func deviceAgentRequest(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        let options = (call.options as? [String: Any]) ?? [:]
        let requestId = stringOption(options, "requestId")
        let method = stringOption(options, "method")
        let payloadJson = stringOption(options, "payloadJson")
        let debugBaseUrl = stringOption(options, "debugBaseUrl")

        guard AgenticDeviceAgentBridgeEnvelope.isValidRequestId(requestId) else {
            resolveEnvelopeError(
                call,
                method: method.isEmpty ? "unknown" : method,
                requestId: requestId.isEmpty ? "invalid-request-id" : requestId,
                debugBaseUrl: debugBaseUrl,
                error: AgenticAgentError(
                    code: "invalid_request_id",
                    message: "Device Agent request id is missing or invalid."
                )
            )
            return
        }
        guard AgenticDeviceAgentBridgeEnvelope.isSupportedMethod(method) else {
            resolveEnvelopeError(
                call,
                method: method.isEmpty ? "unknown" : method,
                requestId: requestId,
                debugBaseUrl: debugBaseUrl,
                error: AgenticAgentError(
                    code: "unsupported_method",
                    message: "iOS Device Agent bridge does not implement \(method)."
                )
            )
            return
        }
        let limit = AgenticDeviceAgentBridgeEnvelope.payloadLimit(for: method)
        if payloadJson.utf8.count > limit {
            resolveEnvelopeError(
                call,
                method: method,
                requestId: requestId,
                debugBaseUrl: debugBaseUrl,
                error: AgenticAgentError(
                    code: "payload_too_large",
                    message: "Payload exceeds \(limit) bytes."
                )
            )
            return
        }

        emitBridgeDebug(baseUrl: debugBaseUrl, method: method, requestId: requestId, step: "bridge_parse_start", [
            "payloadChars": String(payloadJson.count),
            "payloadBytes": String(payloadJson.utf8.count),
        ])
        var payload: [String: Any]
        do {
            payload = try AgenticDeviceAgentBridgeEnvelope.parsePayloadJson(payloadJson)
        } catch let err as AgenticAgentError {
            resolveEnvelopeError(call, method: method, requestId: requestId, debugBaseUrl: debugBaseUrl, error: err)
            return
        } catch {
            resolveEnvelopeError(
                call,
                method: method,
                requestId: requestId,
                debugBaseUrl: debugBaseUrl,
                error: AgenticAgentError(
                    code: "invalid_payload",
                    message: "Device Agent payloadJson could not be parsed."
                )
            )
            return
        }
        if payload["__agenticRequestId"] == nil {
            payload["__agenticRequestId"] = requestId
        }
        if payload["__agenticPayloadChars"] == nil {
            payload["__agenticPayloadChars"] = payloadJson.count
        }
        let payloadDebugBaseUrl = stringOption(payload, "__agenticDebugBaseUrl").isEmpty
            ? debugBaseUrl
            : stringOption(payload, "__agenticDebugBaseUrl")
        emitBridgeDebug(baseUrl: payloadDebugBaseUrl, method: method, requestId: requestId, step: "bridge_parse_done", [
            "payloadChars": String(payloadJson.count),
            "payloadBytes": String(payloadJson.utf8.count),
        ])

        switch method {
        case "status":
            resolveEnvelopeSuccess(
                call,
                method: method,
                requestId: requestId,
                debugBaseUrl: payloadDebugBaseUrl,
                status: AgenticAgentRuntime.shared.status()
            )
        case "configure":
            resolveEnvelopeSuccess(
                call,
                method: method,
                requestId: requestId,
                debugBaseUrl: payloadDebugBaseUrl,
                status: AgenticAgentRuntime.shared.configure(payload)
            )
        case "start":
            resolveEnvelopeSuccess(
                call,
                method: method,
                requestId: requestId,
                debugBaseUrl: payloadDebugBaseUrl,
                status: AgenticAgentRuntime.shared.start(payload)
            )
        case "stop":
            resolveEnvelopeSuccess(
                call,
                method: method,
                requestId: requestId,
                debugBaseUrl: payloadDebugBaseUrl,
                status: AgenticAgentRuntime.shared.stop()
            )
        case "generatePlan":
            dispatchEnvelope(call, method: method, requestId: requestId, payload: payload, debugBaseUrl: payloadDebugBaseUrl) { payload, completion in
                AgenticAgentRuntime.shared.generatePlan(payload, completion: completion)
            }
        case "reviewPlan":
            dispatchEnvelope(call, method: method, requestId: requestId, payload: payload, debugBaseUrl: payloadDebugBaseUrl) { payload, completion in
                AgenticAgentRuntime.shared.reviewPlan(payload, completion: completion)
            }
        case "ask":
            dispatchEnvelope(call, method: method, requestId: requestId, payload: payload, debugBaseUrl: payloadDebugBaseUrl) { payload, completion in
                AgenticAgentRuntime.shared.ask(payload, completion: completion)
            }
        default:
            resolveEnvelopeError(
                call,
                method: method,
                requestId: requestId,
                debugBaseUrl: payloadDebugBaseUrl,
                error: AgenticAgentError(
                    code: "unsupported_method",
                    message: "iOS Device Agent bridge does not implement \(method)."
                )
            )
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let json = call.options as? [String: Any] else {
            call.reject("Missing configuration payload.", "INVALID_PAYLOAD")
            return
        }
        if let limit = enforceSize(json, max: Self.maxConfigPayloadChars) {
            call.reject(limit, "PAYLOAD_TOO_LARGE")
            return
        }
        call.resolve(AgenticAgentRuntime.shared.configure(json))
    }

    @objc func start(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        let json = (call.options as? [String: Any]) ?? [:]
        if let limit = enforceSize(json, max: Self.maxConfigPayloadChars) {
            call.reject(limit, "PAYLOAD_TOO_LARGE")
            return
        }
        call.resolve(AgenticAgentRuntime.shared.start(json))
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        call.resolve(AgenticAgentRuntime.shared.stop())
    }

    @objc func generatePlan(_ call: CAPPluginCall) {
        dispatch(call, method: "generatePlan") { payload, completion in
            AgenticAgentRuntime.shared.generatePlan(payload, completion: completion)
        }
    }

    @objc func reviewPlan(_ call: CAPPluginCall) {
        dispatch(call, method: "reviewPlan") { payload, completion in
            AgenticAgentRuntime.shared.reviewPlan(payload, completion: completion)
        }
    }

    @objc func ask(_ call: CAPPluginCall) {
        dispatch(call, method: "ask") { payload, completion in
            AgenticAgentRuntime.shared.ask(payload, completion: completion)
        }
    }

    private func dispatch(
        _ call: CAPPluginCall,
        method: String,
        invoke: (_ payload: [String: Any], _ completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) -> Void
    ) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        let payload = (call.options as? [String: Any]) ?? [:]
        if let limit = enforceSize(payload, max: Self.maxRequestPayloadChars) {
            call.reject(limit, "PAYLOAD_TOO_LARGE")
            return
        }
        invoke(payload) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let data):
                    guard JSONSerialization.isValidJSONObject(data) else {
                        AgenticIOSLog.fail("AgenticDeviceAgentPlugin", method, "RESOLVE_FAIL", "Device Agent result was not JSON-serializable")
                        call.reject("Device Agent result was not JSON-serializable.", "INVALID_RESPONSE")
                        return
                    }
                    call.resolve(data)
                case .failure(let err):
                    call.reject(err.message, err.code, nil, err.asJson)
                }
            }
        }
    }

    private func dispatchEnvelope(
        _ call: CAPPluginCall,
        method: String,
        requestId: String,
        payload: [String: Any],
        debugBaseUrl: String,
        invoke: (_ payload: [String: Any], _ completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) -> Void
    ) {
        emitBridgeDebug(baseUrl: debugBaseUrl, method: method, requestId: requestId, step: "bridge_runtime_dispatch")
        invoke(payload) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let data):
                    self.resolveEnvelopeSuccess(
                        call,
                        method: method,
                        requestId: requestId,
                        debugBaseUrl: debugBaseUrl,
                        status: AgenticAgentRuntime.shared.status(),
                        result: data
                    )
                case .failure(let err):
                    self.resolveEnvelopeError(
                        call,
                        method: method,
                        requestId: requestId,
                        debugBaseUrl: debugBaseUrl,
                        error: err
                    )
                }
            }
        }
    }

    private func resolveEnvelopeSuccess(
        _ call: CAPPluginCall,
        method: String,
        requestId: String,
        debugBaseUrl: String,
        status: [String: Any],
        result: [String: Any]? = nil
    ) {
        let envelope = AgenticDeviceAgentBridgeEnvelope.success(status: status, result: result)
        guard JSONSerialization.isValidJSONObject(envelope) else {
            resolveEnvelopeError(
                call,
                method: method,
                requestId: requestId,
                debugBaseUrl: debugBaseUrl,
                error: AgenticAgentError(
                    code: "invalid_response",
                    message: "Device Agent response envelope was not JSON-serializable."
                ),
                status: status
            )
            return
        }
        emitBridgeDebug(baseUrl: debugBaseUrl, method: method, requestId: requestId, step: "bridge_resolve_success", [
            "statusState": stringOption(status, "state"),
            "configured": String((status["configured"] as? Bool) == true),
        ])
        call.resolve(envelope)
    }

    private func resolveEnvelopeError(
        _ call: CAPPluginCall,
        method: String,
        requestId: String,
        debugBaseUrl: String,
        error: AgenticAgentError,
        status: [String: Any]? = nil
    ) {
        let statusPayload = status ?? AgenticAgentRuntime.shared.status()
        let envelope = AgenticDeviceAgentBridgeEnvelope.failure(status: statusPayload, error: error)
        emitBridgeDebug(baseUrl: debugBaseUrl, method: method, requestId: requestId, step: "bridge_resolve_error", [
            "code": error.code,
            "subcode": error.subcode ?? "",
            "message": error.message,
            "statusState": stringOption(statusPayload, "state"),
            "configured": String((statusPayload["configured"] as? Bool) == true),
        ])
        call.resolve(envelope)
    }

    private func emitBridgeDebug(
        baseUrl: String,
        method: String,
        requestId: String,
        step: String,
        _ fields: [String: String] = [:]
    ) {
        let baseFields: [String: String] = [
            "method": method,
            "requestId": requestId,
            "runtime": "ios-native",
            "phase": "bridge_envelope",
            "step": step,
        ]
        AgenticDeviceAgentDebugTelemetry.emit(
            baseUrl: baseUrl.isEmpty ? nil : baseUrl,
            fields: baseFields.merging(fields) { current, _ in current }
        )
        AgenticIOSLog.info("AgenticDeviceAgentPlugin", method, step.uppercased(), "Device Agent bridge envelope \(step)", [
            "requestId": requestId,
        ])
    }

    private func stringOption(_ json: [String: Any], _ key: String) -> String {
        guard let value = json[key] as? String else { return "" }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func enforceSize(_ json: [String: Any], max: Int) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: json, options: []) else {
            return nil
        }
        return data.count > max ? "Payload exceeds \(max) bytes." : nil
    }
}
