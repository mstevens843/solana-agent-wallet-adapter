// Public entry points the host app's AppDelegate calls to bootstrap the bridge.
// Keeps internal types (AgenticRemoteConfigStore, AgenticIOSLog, …) internal
// while exposing a small, stable surface to the iOS Capacitor app.
import Foundation
import UIKit

public enum AgenticBridge {
    // Finite-length background task so the WalletConnect relay socket survives
    // the brief window the user is in Jupiter approving — long enough for the
    // signed response to arrive and the return notification to fire. Always
    // ended (didBecomeActive + expiration handler) or iOS watchdog-kills us.
    private static var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
    private static let backgroundTaskLock = NSLock()
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
    /// in-store by 60s; force=false respects that) and tidies up the WalletConnect
    /// backgrounding plumbing now that the user is back.
    public static func didBecomeActive() {
        AgenticRemoteConfigStore.shared.refresh(force: false)
        endBackgroundTask()
        AgenticLocalNotification.clearWalletConnectNotifications()
        AgenticIOSLog.info("AgenticBridge", "didBecomeActive", "DONE", "lifecycle hook")
    }

    /// Hook into `applicationWillResignActive(_:)`. Begins a short background task
    /// so the WalletConnect relay socket can receive a signing response while the
    /// user approves in Jupiter.
    public static func willResignActive() {
        beginBackgroundTask()
        AgenticIOSLog.info("AgenticBridge", "willResignActive", "DONE", "lifecycle hook")
    }

    private static func beginBackgroundTask() {
        backgroundTaskLock.lock()
        defer { backgroundTaskLock.unlock() }
        guard backgroundTaskId == .invalid else {
            AgenticIOSLog.info("AgenticBridge", "backgroundTask", "ALREADY_ACTIVE", "WC relay background task already running")
            return
        }
        backgroundTaskId = UIApplication.shared.beginBackgroundTask(withName: "agentic.wc.relay") {
            AgenticIOSLog.fail("AgenticBridge", "backgroundTask", "EXPIRED", "WC relay background task expired before resume — relay socket will freeze until foreground")
            endBackgroundTask()
        }
        let remaining = UIApplication.shared.backgroundTimeRemaining
        AgenticIOSLog.info("AgenticBridge", "backgroundTask", "BEGAN", "began WC relay background task", [
            "backgroundTimeRemaining": remaining > 100_000 ? "max" : String(format: "%.0f", remaining),
        ])
    }

    private static func endBackgroundTask() {
        backgroundTaskLock.lock()
        defer { backgroundTaskLock.unlock() }
        guard backgroundTaskId != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTaskId)
        backgroundTaskId = .invalid
        AgenticIOSLog.info("AgenticBridge", "backgroundTask", "ENDED", "ended WC relay background task")
    }

    /// Route WalletConnect/Reown link-mode callbacks before Capacitor handles
    /// ordinary app links. Returns true only when the URL contained a WC envelope.
    public static func handleOpenUrl(_ url: URL) -> Bool {
        var handled = false
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            handled = AgenticWalletConnectCore.shared.dispatchEnvelope(url)
        }
#endif
        // CRITICAL diagnostic: log EVERY inbound URL, including a plain
        // agenticwallet:// return from Jupiter that carries no WC envelope
        // (handled=false). This is the "did Jupiter's return-redirect actually
        // reach us?" signal — previously this path produced no log at all.
        let queryKeys = URLComponents(url: url, resolvingAgainstBaseURL: true)?
            .queryItems?.map(\.name).sorted().joined(separator: ",") ?? ""
        AgenticIOSLog.info("AgenticBridge", "handleOpenUrl", handled ? "WC_ENVELOPE_DISPATCHED" : "INBOUND_URL", "inbound URL received", [
            "scheme": url.scheme ?? "none",
            "host": url.host ?? "none",
            "path": url.path,
            "queryKeys": queryKeys,
            "handledAsWcEnvelope": handled ? "true" : "false",
        ])
        return handled
    }

    /// Route Universal Link WalletConnect envelopes when the wallet returns via
    /// associated domain instead of the custom scheme.
    public static func handleUserActivity(_ userActivity: NSUserActivity) -> Bool {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL else {
            AgenticIOSLog.info("AgenticBridge", "handleUserActivity", "NON_WEB_ACTIVITY", "ignored non-web user activity", [
                "activityType": userActivity.activityType,
            ])
            return false
        }
        AgenticIOSLog.info("AgenticBridge", "handleUserActivity", "INBOUND_UNIVERSAL_LINK", "inbound universal link received", [
            "host": url.host ?? "none",
            "path": url.path,
        ])
        return handleOpenUrl(url)
    }
}
