import Capacitor
import Foundation

@objc(AgenticStreamingSessionPlugin)
public class AgenticStreamingSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticStreamingSessionPlugin"
    public let jsName = "AgenticStreamingSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prepareSessionSigner", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bindPreparedSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activateSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signVoucher", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signSettlementTx", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "revokeLocalSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "statusJson", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notificationState", returnType: CAPPluginReturnPromise),
    ]

    // Backed by AgenticStreamingSessionController (Phase 4).
    // Mirrors apps/android-twa/.../streaming/StreamingSessionController.kt.

    @objc func prepareSessionSigner(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        let metadata = call.getObject("metadata")
        let result = AgenticStreamingSessionController.shared.prepareSessionSigner(metadata: metadata)
        call.resolve(result)
    }

    @objc func createSession(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let sessionId = call.getString("sessionId"), !sessionId.isEmpty else {
            call.reject("Missing sessionId.", "INVALID_SESSION_ID")
            return
        }
        guard let privKey = call.getString("ephemeralPrivkeyBase64") else {
            call.reject("Missing ephemeralPrivkeyBase64.", "INVALID_PRIVKEY")
            return
        }
        let metadata = call.getObject("metadata")
        let result = AgenticStreamingSessionController.shared.createSession(
            sessionId: sessionId,
            ephemeralPrivkeyBase64: privKey,
            metadata: metadata
        )
        call.resolve(result)
    }

    @objc func bindPreparedSession(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let sessionId = call.getString("sessionId"), let signerId = call.getString("signerId") else {
            call.reject("Missing sessionId or signerId.", "INVALID_PARAMS")
            return
        }
        let result = AgenticStreamingSessionController.shared.bindPreparedSession(
            sessionId: sessionId,
            signerId: signerId,
            metadata: call.getObject("metadata")
        )
        call.resolve(result)
    }

    @objc func activateSession(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let sessionId = call.getString("sessionId") else {
            call.reject("Missing sessionId.", "INVALID_SESSION_ID")
            return
        }
        let result = AgenticStreamingSessionController.shared.activateSession(
            sessionId: sessionId,
            metadata: call.getObject("metadata")
        )
        call.resolve(result)
    }

    @objc func signVoucher(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let sessionId = call.getString("sessionId") else {
            call.reject("Missing sessionId.", "INVALID_SESSION_ID")
            return
        }
        guard let voucherJson = call.getString("voucherJson") else {
            call.reject("Missing voucherJson.", "INVALID_VOUCHER")
            return
        }
        let result = AgenticStreamingSessionController.shared.signVoucher(
            sessionId: sessionId,
            voucherJson: voucherJson
        )
        call.resolve(result)
    }

    @objc func signSettlementTx(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let sessionId = call.getString("sessionId") else {
            call.reject("Missing sessionId.", "INVALID_SESSION_ID")
            return
        }
        guard let settlement = call.getObject("settlement") else {
            call.reject("Missing settlement.", "INVALID_SETTLEMENT")
            return
        }
        let result = AgenticStreamingSessionController.shared.signSettlementTx(
            sessionId: sessionId,
            settlement: settlement
        )
        call.resolve(result)
    }

    @objc func revokeLocalSession(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let sessionId = call.getString("sessionId") else {
            call.reject("Missing sessionId.", "INVALID_SESSION_ID")
            return
        }
        let result = AgenticStreamingSessionController.shared.revokeLocalSession(sessionId: sessionId)
        call.resolve(result)
    }

    @objc func statusJson(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        call.resolve(AgenticStreamingSessionController.shared.statusJson())
    }

    @objc func notificationState(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        call.resolve(AgenticStreamingSessionController.shared.notificationState())
    }
}
