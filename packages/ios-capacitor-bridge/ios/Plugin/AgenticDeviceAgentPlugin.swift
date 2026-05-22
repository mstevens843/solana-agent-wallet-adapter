import Capacitor
import Foundation

@objc(AgenticDeviceAgentPlugin)
public class AgenticDeviceAgentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticDeviceAgentPlugin"
    public let jsName = "AgenticDeviceAgent"
    public let pluginMethods: [CAPPluginMethod] = [
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
    private static let maxConfigPayloadChars = 8_192
    private static let maxRequestPayloadChars = 2_000_000

    @objc func status(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        call.resolve(AgenticAgentRuntime.shared.status())
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
            switch result {
            case .success(let data):
                call.resolve(data)
            case .failure(let err):
                call.reject(err.message, err.code, nil, err.asJson)
            }
        }
    }

    private func enforceSize(_ json: [String: Any], max: Int) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: json, options: []) else {
            return nil
        }
        return data.count > max ? "Payload exceeds \(max) bytes." : nil
    }
}
