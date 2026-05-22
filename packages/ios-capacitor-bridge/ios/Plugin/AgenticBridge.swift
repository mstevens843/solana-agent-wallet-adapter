// Public entry points the host app's AppDelegate calls to bootstrap the bridge.
// Keeps internal types (AgenticRemoteConfigStore, AgenticIOSLog, …) internal
// while exposing a small, stable surface to the iOS Capacitor app.
import Foundation

public enum AgenticBridge {
    /// Bootstrap step #1 — called from `application(_:didFinishLaunchingWithOptions:)`.
    /// `cloudBaseUrl` is the origin for `/api/mobile-config` and other cloud
    /// endpoints. Falls back to `https://agentic-signer.com` when omitted.
    public static func initialize(cloudBaseUrl: String? = nil) {
        let base = (cloudBaseUrl?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? cloudBaseUrl!
            : (Bundle.main.object(forInfoDictionaryKey: "AGENTIC_CLOUD_API_BASE_URL") as? String)
            ?? "https://agentic-signer.com"
        AgenticRemoteConfigStore.shared.initialize(baseUrl: base)
        AgenticIOSLog.info("AgenticBridge", "initialize", "DONE", "bootstrap complete", [
            "cloudBaseUrl": base,
        ])
        // Kick a non-blocking refresh; result lands in cache for the next caller.
        AgenticRemoteConfigStore.shared.refresh(force: false)
    }

    /// Hook into `applicationDidBecomeActive(_:)`. Refreshes remote config (debounced
    /// in-store by 60s; force=false respects that).
    public static func didBecomeActive() {
        AgenticRemoteConfigStore.shared.refresh(force: false)
        AgenticIOSLog.info("AgenticBridge", "didBecomeActive", "DONE", "lifecycle hook")
    }

    /// Hook into `applicationWillResignActive(_:)`. Future phases use this to
    /// snapshot in-flight DeviceAgent / Streaming work for short-tail backgrounding.
    public static func willResignActive() {
        AgenticIOSLog.info("AgenticBridge", "willResignActive", "DONE", "lifecycle hook")
    }
}
