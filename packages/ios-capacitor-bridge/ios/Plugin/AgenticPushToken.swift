import Foundation

/// Bridges the APNs device token from the AppDelegate (where iOS delivers it) to the
/// AgenticSystem plugin (where JS asks for it).
///
/// The two arrive on independent clocks: `registerForPush()` may be called from JS before
/// `didRegisterForRemoteNotifications` fires, or after. So this holds the latest token AND a pending
/// continuation, and satisfies whichever comes second — no polling.
///
/// A tap on a delivered push routes through `pendingTapRoute`, drained by the plugin's tap listener.
@objc public final class AgenticPushTokenStore: NSObject {
    @objc public static let shared = AgenticPushTokenStore()

    private let queue = DispatchQueue(label: "com.agentic.push.token")
    private var latestToken: String?
    private var latestError: String?
    private var waiters: [(String?, String?) -> Void] = []
    /// Tap payloads that arrived before JS attached its listener; drained on attach.
    private var bufferedTaps: [[String: Any]] = []
    private var tapListener: (([String: Any]) -> Void)?

    private override init() { super.init() }

    /// Called by the AppDelegate on successful APNs registration. `deviceToken` is the raw Data;
    /// we hex-encode it (the APNs HTTP/2 path on the server addresses `/3/device/<hex>`).
    @objc public func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        queue.async {
            self.latestToken = hex
            self.latestError = nil
            let pending = self.waiters
            self.waiters.removeAll()
            for waiter in pending { waiter(hex, nil) }
        }
    }

    @objc public func didFailToRegister(error: String) {
        queue.async {
            self.latestError = error
            let pending = self.waiters
            self.waiters.removeAll()
            for waiter in pending { waiter(nil, error) }
        }
    }

    /// Resolve the current APNs token. If one is already known, returns it immediately; otherwise
    /// waits for the next registration result. `UIApplication.registerForRemoteNotifications()` must
    /// have been called (the plugin does so) or this never resolves — hence the caller's timeout.
    @objc public func awaitToken(_ completion: @escaping (String?, String?) -> Void) {
        queue.async {
            if let token = self.latestToken { completion(token, nil); return }
            if let error = self.latestError { completion(nil, error); return }
            self.waiters.append(completion)
        }
    }

    // ---- Tap routing ----

    @objc public func handleTap(userInfo: [AnyHashable: Any]) {
        var route: [String: Any] = [:]
        for (key, value) in userInfo where key is String {
            route[key as! String] = value
        }
        queue.async {
            if let listener = self.tapListener {
                DispatchQueue.main.async { listener(route) }
            } else {
                self.bufferedTaps.append(route)
            }
        }
    }

    func setTapListener(_ listener: @escaping ([String: Any]) -> Void) {
        queue.async {
            self.tapListener = listener
            let buffered = self.bufferedTaps
            self.bufferedTaps.removeAll()
            for tap in buffered { DispatchQueue.main.async { listener(tap) } }
        }
    }
}
