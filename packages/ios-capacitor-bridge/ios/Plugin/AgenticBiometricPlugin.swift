import Capacitor
import Foundation
import LocalAuthentication

@objc(AgenticBiometricPlugin)
public class AgenticBiometricPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticBiometricPlugin"
    public let jsName = "AgenticBiometric"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "canAuthenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prompt", returnType: CAPPluginReturnPromise),
    ]

    // MARK: SECURITY NOTE
    // This is a UX gate, NOT a cryptographic security boundary. The result is
    // delivered to JavaScript and any compromised page in the WebView realm can
    // forge a success response. Do not release secret material on the strength
    // of this signal alone; use it only to gesture-gate sensitive UI actions.
    // Mirrors apps/android-twa/.../system/BiometricBridge.kt lines 20–46.

    @objc func canAuthenticate(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        let context = LAContext()
        var error: NSError?
        let allowDeviceCredential = call.getBool("allowDeviceCredential", false)
        let policy: LAPolicy = allowDeviceCredential
            ? .deviceOwnerAuthentication
            : .deviceOwnerAuthenticationWithBiometrics

        let available = context.canEvaluatePolicy(policy, error: &error)
        if available {
            AgenticIOSLog.info("AgenticBiometric", "canAuthenticate", "DONE", "biometric available", [
                "biometryType": biometryName(context.biometryType),
                "allowDeviceCredential": String(allowDeviceCredential),
            ])
            call.resolve([
                "status": 0,
                "kind": "AVAILABLE",
                "biometryType": biometryName(context.biometryType),
            ])
            return
        }

        let code = error?.code ?? -1
        let kindString = errorKind(code)
        AgenticIOSLog.info("AgenticBiometric", "canAuthenticate", "DONE", "biometric unavailable", [
            "kind": kindString,
            "code": String(code),
        ])
        call.resolve([
            "status": code,
            "kind": kindString,
            "biometryType": biometryName(context.biometryType),
            "message": error?.localizedDescription ?? "Unavailable",
        ])
    }

    @objc func prompt(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        let context = LAContext()
        let allowDeviceCredential = call.getBool("allowDeviceCredential", false)
        let policy: LAPolicy = allowDeviceCredential
            ? .deviceOwnerAuthentication
            : .deviceOwnerAuthenticationWithBiometrics

        let reason = call.getString("reason")
            ?? call.getString("subtitle")
            ?? call.getString("description")
            ?? call.getString("title")
            ?? "Confirm to continue"

        if let fallbackTitle = call.getString("fallbackTitle") {
            context.localizedFallbackTitle = fallbackTitle
        }
        if let cancelTitle = call.getString("negativeButton") {
            context.localizedCancelTitle = cancelTitle
        }

        var probeError: NSError?
        guard context.canEvaluatePolicy(policy, error: &probeError) else {
            let kindString = errorKind(probeError?.code ?? -1)
            AgenticIOSLog.fail("AgenticBiometric", "prompt", "REJECT", "policy unavailable", [
                "kind": kindString,
                "code": String(probeError?.code ?? -1),
            ])
            call.resolve([
                "ok": false,
                "kind": kindString,
                "code": probeError?.code ?? -1,
                "message": probeError?.localizedDescription ?? "Unavailable",
            ])
            return
        }

        context.evaluatePolicy(policy, localizedReason: reason) { [weak self] success, evalError in
            DispatchQueue.main.async {
                guard let self else { return }
                if success {
                    AgenticIOSLog.info("AgenticBiometric", "prompt", "DONE", "auth succeeded", [
                        "authType": "biometric",
                    ])
                    call.resolve([
                        "ok": true,
                        "kind": "AUTH_SUCCEEDED",
                        "authType": "biometric",
                    ])
                    return
                }
                let code = (evalError as NSError?)?.code ?? -1
                let kindString = self.errorKind(code)
                AgenticIOSLog.fail("AgenticBiometric", "prompt", "FAIL", "auth failed", [
                    "kind": kindString,
                    "code": String(code),
                ])
                call.resolve([
                    "ok": false,
                    "kind": kindString,
                    "code": code,
                    "message": evalError?.localizedDescription ?? "Auth failed",
                ])
            }
        }
    }

    private func biometryName(_ type: LABiometryType) -> String {
        switch type {
        case .faceID: return "FACE_ID"
        case .touchID: return "TOUCH_ID"
        case .none: return "NONE"
        default:
            if #available(iOS 17, *), type == .opticID {
                return "OPTIC_ID"
            }
            return "UNKNOWN"
        }
    }

    private func errorKind(_ code: Int) -> String {
        switch code {
        case LAError.authenticationFailed.rawValue: return "AUTH_FAILED"
        case LAError.userCancel.rawValue: return "USER_CANCEL"
        case LAError.userFallback.rawValue: return "USER_FALLBACK"
        case LAError.systemCancel.rawValue: return "SYSTEM_CANCEL"
        case LAError.passcodeNotSet.rawValue: return "PASSCODE_NOT_SET"
        case LAError.biometryNotAvailable.rawValue: return "NO_HARDWARE"
        case LAError.biometryNotEnrolled.rawValue: return "NO_ENROLLED"
        case LAError.biometryLockout.rawValue: return "LOCKED_OUT"
        case LAError.appCancel.rawValue: return "APP_CANCEL"
        case LAError.invalidContext.rawValue: return "INVALID_CONTEXT"
        case LAError.notInteractive.rawValue: return "NOT_INTERACTIVE"
        default: return "UNKNOWN"
        }
    }
}
