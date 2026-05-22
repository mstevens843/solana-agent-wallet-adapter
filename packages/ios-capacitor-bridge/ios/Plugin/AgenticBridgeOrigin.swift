import Capacitor
import Foundation
import WebKit

// Origin-gating helper for every plugin entry point. Mirrors the Android
// checkTrustedOrigin pattern from apps/android-twa/.../system/SystemBridge.kt:52-92.
//
// Rationale: even though Capacitor's WKWebView is configured for a single origin
// in capacitor.config.json, defensive checks here prevent a future misconfiguration
// (or a debug build pointed at LAN) from exposing the bridge to untrusted pages.
//
// Tunable via the AGENTIC_ALLOWED_ORIGINS Info.plist key (comma-separated list).

enum AgenticBridgeOrigin {
    static let defaultAllowed: Set<String> = [
        "https://agentic-signer.com",
        "https://agentic-seeker.com",
        "capacitor://localhost", // Capacitor's default native origin
    ]

    private static let allowed: Set<String> = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "AGENTIC_ALLOWED_ORIGINS") as? String else {
            return defaultAllowed
        }
        let parsed = raw.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parsed.isEmpty ? defaultAllowed : Set(parsed)
    }()

    /// Returns true and allows the call to proceed; returns false and rejects the
    /// call with UNTRUSTED_ORIGIN if the WebView is loading an unexpected origin.
    @discardableResult
    static func validate(_ call: CAPPluginCall, on bridge: CAPBridgeProtocol?) -> Bool {
        guard let webView = bridge?.webView,
              let url = webView.url,
              let scheme = url.scheme,
              let host = url.host else {
            // Unknown origin (e.g., about:blank) — reject defensively.
            AgenticIOSLog.fail("BridgeOrigin", "validate", "REJECT", "origin unavailable")
            call.reject("Origin unavailable.", "UNTRUSTED_ORIGIN")
            return false
        }
        let port = url.port.map { ":\($0)" } ?? ""
        let origin = "\(scheme)://\(host)\(port)"
        if allowed.contains(origin) {
            return true
        }
        AgenticIOSLog.fail("BridgeOrigin", "validate", "REJECT", "untrusted origin", ["origin": origin])
        call.reject("Untrusted origin.", "UNTRUSTED_ORIGIN")
        return false
    }
}
