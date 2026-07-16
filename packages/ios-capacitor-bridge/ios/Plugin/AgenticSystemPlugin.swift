import Capacitor
import Foundation
import UIKit
import UserNotifications

@objc(AgenticSystemPlugin)
public class AgenticSystemPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticSystemPlugin"
    public let jsName = "AgenticSystem"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "systemInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clipboardWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clipboardRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showNotification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotificationAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerForPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "appLifecycleState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keyboardMetrics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "devLog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDebugLogging", returnType: CAPPluginReturnPromise),
    ]

    private static let allowedSchemes: Set<String> = ["https", "http", "mailto", "tel", "sms", "phantom", "solflare", "backpack", "jupiter", "wc"]
    private static let maxUrlLength = 32_768
    private static let maxClipboardBytes = 1_000_000

    // Cached haptic generators (Apple docs: create once, prepare(), reuse).
    private lazy var lightImpact: UIImpactFeedbackGenerator = {
        let gen = UIImpactFeedbackGenerator(style: .light); gen.prepare(); return gen
    }()
    private lazy var mediumImpact: UIImpactFeedbackGenerator = {
        let gen = UIImpactFeedbackGenerator(style: .medium); gen.prepare(); return gen
    }()
    private lazy var heavyImpact: UIImpactFeedbackGenerator = {
        let gen = UIImpactFeedbackGenerator(style: .heavy); gen.prepare(); return gen
    }()
    private lazy var notificationFeedback: UINotificationFeedbackGenerator = {
        let gen = UINotificationFeedbackGenerator(); gen.prepare(); return gen
    }()
    private var keyboardInset: CGFloat = 0

    public override func load() {
        super.load()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardFrameChanged(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardFrameChanged(_:)),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
        // Forward notification taps to JS. A tap that arrived before this listener was attached (cold
        // launch from a notification) is buffered in the store and delivered here on attach.
        AgenticPushTokenStore.shared.setTapListener { [weak self] route in
            self?.notifyListeners("pushNotificationTap", data: route)
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // Mirrors apps/android-twa/.../system/SystemBridge.kt.

    @objc func openExternal(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let raw = call.getString("url"), !raw.isEmpty else {
            AgenticIOSLog.fail("AgenticSystem", "openExternal", "REJECT", "missing url")
            call.reject("Missing url.", "INVALID_URL")
            return
        }
        guard raw.count <= Self.maxUrlLength else {
            AgenticIOSLog.fail("AgenticSystem", "openExternal", "REJECT", "url too long", ["len": String(raw.count)])
            call.reject("URL too long.", "URL_TOO_LONG")
            return
        }
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              Self.allowedSchemes.contains(scheme) else {
            AgenticIOSLog.fail("AgenticSystem", "openExternal", "REJECT", "scheme not allowed", ["scheme": String(URL(string: raw)?.scheme ?? "(nil)")])
            call.reject("Unsupported URL.", "INVALID_URL")
            return
        }
        AgenticIOSLog.info("AgenticSystem", "openExternal", "START", "dispatching", ["scheme": scheme])
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                if ok {
                    AgenticIOSLog.info("AgenticSystem", "openExternal", "DONE", "opened")
                } else {
                    AgenticIOSLog.fail("AgenticSystem", "openExternal", "FAIL", "system declined")
                }
                call.resolve(["ok": ok])
            }
        }
    }

    @objc func systemInfo(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        // Touch the monitor singleton to ensure NWPathMonitor is running.
        _ = AgenticNetworkMonitor.shared
        DispatchQueue.main.async {
            let device = UIDevice.current
            device.isBatteryMonitoringEnabled = true
            let battery = device.batteryLevel
            let bundleId = Bundle.main.bundleIdentifier ?? ""
            let sysVersion = device.systemVersion
            let sdkInt = Int(sysVersion.split(separator: ".").first.map(String.init) ?? "0") ?? 0
            let info: [String: Any] = [
                "manufacturer": "Apple",
                "model": device.model,
                "device": device.name,
                "systemVersion": sysVersion,
                "sdkInt": sdkInt,
                "release": sysVersion,
                "locale": Locale.current.identifier,
                "timezone": TimeZone.current.identifier,
                "batteryPercent": battery >= 0 ? Int(battery * 100) : -1,
                "networkType": AgenticNetworkMonitor.shared.current,
                "packageName": bundleId,
                "webViewContentInset": "never",
                "layoutContract": "ios-css-safe-area-v1",
            ]
            AgenticIOSLog.info("AgenticSystem", "systemInfo", "DONE", "snapshot", [
                "packageName": bundleId,
                "sdkInt": String(sdkInt),
                "layoutContract": "ios-css-safe-area-v1",
                "network": AgenticNetworkMonitor.shared.current,
            ])
            call.resolve(info)
        }
    }

    @objc func clipboardWrite(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let text = call.getString("text") else {
            call.reject("Missing text.", "INVALID_TEXT")
            return
        }
        guard text.utf8.count <= Self.maxClipboardBytes else {
            AgenticIOSLog.fail("AgenticSystem", "clipboardWrite", "REJECT", "payload too large", ["bytes": String(text.utf8.count)])
            call.reject("Clipboard payload too large.", "PAYLOAD_TOO_LARGE")
            return
        }
        DispatchQueue.main.async {
            UIPasteboard.general.string = text
            AgenticIOSLog.info("AgenticSystem", "clipboardWrite", "DONE", "written", ["bytes": String(text.utf8.count)])
            call.resolve(["ok": true])
        }
    }

    // Read the system clipboard text for the WebView "Paste key" button. WKWebView's
    // navigator.clipboard.readText() works only over a secure context + user gesture and
    // surfaces the iOS paste callout, so the native read gives the same one-tap paste as
    // the Android clipboardRead bridge. UIPasteboard.general reads are unrestricted (no
    // Info.plist entry); iOS provides its own paste affordance. Returns "" when empty.
    @objc func clipboardRead(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        DispatchQueue.main.async {
            let text = UIPasteboard.general.string ?? ""
            AgenticIOSLog.info("AgenticSystem", "clipboardRead", "DONE", "read", ["bytes": String(text.utf8.count)])
            call.resolve(["text": text])
        }
    }

    @objc func haptic(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        let pattern = call.getString("pattern", "light").lowercased()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch pattern {
            case "heavy":
                self.heavyImpact.impactOccurred()
                self.heavyImpact.prepare()
            case "medium":
                self.mediumImpact.impactOccurred()
                self.mediumImpact.prepare()
            case "success":
                self.notificationFeedback.notificationOccurred(.success)
                self.notificationFeedback.prepare()
            case "warning":
                self.notificationFeedback.notificationOccurred(.warning)
                self.notificationFeedback.prepare()
            case "error":
                self.notificationFeedback.notificationOccurred(.error)
                self.notificationFeedback.prepare()
            default:
                self.lightImpact.impactOccurred()
                self.lightImpact.prepare()
            }
            AgenticIOSLog.info("AgenticSystem", "haptic", "DONE", "triggered", ["pattern": pattern])
            call.resolve(["ok": true])
        }
    }

    @objc func showNotification(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let title = call.getString("title"), !title.isEmpty else {
            call.reject("Missing title.", "INVALID_TITLE")
            return
        }
        let body = call.getString("body", "")
        let tag = call.getString("tag") ?? UUID().uuidString

        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let proceed: (UNAuthorizationStatus) -> Void = { status in
                guard status == .authorized || status == .provisional || status == .ephemeral else {
                    AgenticIOSLog.fail("AgenticSystem", "showNotification", "REJECT", "not authorized", ["status": String(status.rawValue)])
                    call.resolve(["ok": false, "kind": "NOT_AUTHORIZED"])
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.sound = .default
                let request = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
                center.add(request) { error in
                    DispatchQueue.main.async {
                        if let error {
                            AgenticIOSLog.fail("AgenticSystem", "showNotification", "FAIL", "add failed", ["error": error.localizedDescription])
                            call.resolve(["ok": false, "kind": "ERROR", "message": error.localizedDescription])
                        } else {
                            AgenticIOSLog.info("AgenticSystem", "showNotification", "DONE", "posted", ["id": tag])
                            call.resolve(["ok": true, "id": tag, "tag": tag])
                        }
                    }
                }
            }
            if settings.authorizationStatus == .notDetermined {
                center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
                    proceed(granted ? .authorized : .denied)
                }
            } else {
                proceed(settings.authorizationStatus)
            }
        }
    }

    @objc func requestNotificationAuthorization(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        // Request-only: prompt for permission without posting a notification, so
        // callers can ask at a deliberate moment (e.g. right after connecting
        // Jupiter) and then post return notifications silently later.
        AgenticLocalNotification.requestAuthorization { status in
            AgenticIOSLog.info("AgenticSystem", "requestNotificationAuthorization", "DONE", "resolved", [
                "status": status,
            ])
            call.resolve(["status": status])
        }
    }

    /// Prompt for authorization (if needed) and register for remote (APNs) push, resolving the hex
    /// device token JS forwards to /api/push/register-device. Rejects if the user denies, or times out
    /// if APNs never answers (offline, no aps-environment) so JS is never left hanging.
    @objc func registerForPush(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        AgenticLocalNotification.requestAuthorization { status in
            guard status == "authorized" || status == "provisional" || status == "ephemeral" else {
                AgenticIOSLog.fail("AgenticSystem", "registerForPush", "REJECT", "not authorized", ["status": status])
                call.resolve(["ok": false, "status": status])
                return
            }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
            var settled = false
            let finish: (CAPPluginCallResultData) -> Void = { data in
                guard !settled else { return }
                settled = true
                call.resolve(data)
            }
            AgenticPushTokenStore.shared.awaitToken { token, error in
                if let token {
                    AgenticIOSLog.info("AgenticSystem", "registerForPush", "DONE", "token acquired")
                    finish(["ok": true, "status": status, "platform": "ios", "token": token])
                } else {
                    AgenticIOSLog.fail("AgenticSystem", "registerForPush", "FAIL", "apns error", ["error": error ?? "unknown"])
                    finish(["ok": false, "status": status, "message": error ?? "APNs registration failed."])
                }
            }
            // APNs can silently never call back (airplane mode, provisioning gap). A bounded wait keeps
            // the JS promise from hanging; a later token still flows via the pushTokenChange listener.
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                finish(["ok": false, "status": status, "message": "APNs registration timed out."])
            }
        }
    }

    @objc func devLog(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        // Bridge JS step logs into the same native syslog stream as AgenticIOSLog
        // so a single `idevicesyslog | grep "[AgentIOSApp]"` shows the whole
        // Jupiter flow (native + JS) in one terminal.
        let component = call.getString("component") ?? "JS"
        let method = call.getString("method") ?? "log"
        let step = call.getString("step") ?? "STEP"
        let level = call.getString("level", "info").lowercased()
        let message = call.getString("message") ?? ""
        var metadata: [String: String] = [:]
        if let obj = call.getObject("metadata") {
            for (key, value) in obj {
                metadata[key] = (value as? String) ?? String(describing: value)
            }
        }
        if level == "fail" || level == "error" {
            AgenticIOSLog.fail(component, method, step, message, metadata)
        } else {
            AgenticIOSLog.info(component, method, step, message, metadata)
        }
        call.resolve(["ok": true])
    }

    @objc func setDebugLogging(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        let enabled = call.getBool("enabled") ?? false
        AgenticIOSLog.setRawValues(enabled)
        AgenticIOSLog.info("AgenticSystem", "setDebugLogging", "DONE", "raw value logging toggled", [
            "enabled": enabled ? "true" : "false",
        ])
        call.resolve(["ok": true])
    }

    @objc func appLifecycleState(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        DispatchQueue.main.async {
            let state: String
            switch UIApplication.shared.applicationState {
            case .active: state = "active"
            case .inactive: state = "inactive"
            case .background: state = "background"
            @unknown default: state = "unknown"
            }
            call.resolve(["state": state])
        }
    }

    @objc func keyboardMetrics(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        DispatchQueue.main.async {
            call.resolve(self.keyboardMetricsPayload())
        }
    }

    @objc private func keyboardFrameChanged(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let nextInset = self.keyboardInset(from: notification)
            guard abs(self.keyboardInset - nextInset) >= 1 else { return }
            self.keyboardInset = nextInset
            self.notifyListeners("keyboardInsetChange", data: self.keyboardMetricsPayload())
        }
    }

    private func keyboardInset(from notification: Notification) -> CGFloat {
        if notification.name == UIResponder.keyboardWillHideNotification {
            return 0
        }
        guard
            let webView = bridge?.webView,
            let frameValue = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue
        else {
            return 0
        }
        let keyboardFrame = webView.convert(frameValue.cgRectValue, from: nil)
        let overlap = max(0, webView.bounds.maxY - keyboardFrame.minY)
        return max(0, overlap - webView.safeAreaInsets.bottom)
    }

    private func keyboardMetricsPayload() -> [String: Any] {
        let inset = max(0, Int(round(keyboardInset)))
        return [
            "keyboardInset": inset,
            "visible": inset > 0,
        ]
    }
}
