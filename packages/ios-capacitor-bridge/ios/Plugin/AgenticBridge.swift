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

    /// Route WalletConnect/Reown link-mode callbacks before Capacitor handles
    /// ordinary app links. Returns true only when the URL contained a WC envelope.
    public static func handleOpenUrl(_ url: URL) -> Bool {
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            return AgenticWalletConnectCore.shared.dispatchEnvelope(url)
        }
#endif
        return false
    }

    /// Route Universal Link WalletConnect envelopes when the wallet returns via
    /// associated domain instead of the custom scheme.
    public static func handleUserActivity(_ userActivity: NSUserActivity) -> Bool {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL else {
            return false
        }
        return handleOpenUrl(url)
    }
}
