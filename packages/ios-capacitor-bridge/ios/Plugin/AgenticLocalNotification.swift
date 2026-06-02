import Foundation
import UserNotifications

/// Shared local-notification helpers used by both the AgenticSystem plugin
/// (JS-driven) and the WalletConnect core (native return notifications).
///
/// On iOS 17+/18 Apple blocks silent app-to-app redirects, so after a Jupiter
/// WalletConnect approval we cannot reliably foreground Agentic on our own.
/// The signed result still arrives over the relay; this notification is how the
/// user gets back into Agentic to see it. Scheduling must happen natively
/// because the WKWebView/JS runtime is suspended while the user is in Jupiter.
enum AgenticLocalNotification {
    /// Identifier prefix for WalletConnect return notifications so they can be
    /// cleared in bulk when the app returns to the foreground.
    static let walletConnectPrefix = "agentic.wc."

    /// Request notification authorization WITHOUT posting anything. Resolves a
    /// status string ("authorized" | "provisional" | "ephemeral" | "denied" |
    /// "unknown"). Use this to prompt at a deliberate moment (e.g. Jupiter
    /// connect) instead of the first time we need to post.
    static func requestAuthorization(completion: @escaping (String) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    completion(granted ? "authorized" : "denied")
                }
            case .authorized:
                completion("authorized")
            case .provisional:
                completion("provisional")
            case .ephemeral:
                completion("ephemeral")
            case .denied:
                completion("denied")
            @unknown default:
                completion("unknown")
            }
        }
    }

    /// Post an immediate local notification IF already authorized. Never prompts
    /// (authorization is requested up front at connect). No-ops when the user
    /// has not granted permission.
    static func postIfAuthorized(
        title: String,
        body: String,
        tag: String,
        userInfo: [String: Any] = [:]
    ) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let status = settings.authorizationStatus
            guard status == .authorized || status == .provisional || status == .ephemeral else {
                AgenticIOSLog.info("AgenticLocalNotification", "postIfAuthorized", "SKIP", "not authorized", [
                    "status": String(status.rawValue),
                ])
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            if !userInfo.isEmpty { content.userInfo = userInfo }
            let request = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
            center.add(request) { error in
                if let error {
                    AgenticIOSLog.fail("AgenticLocalNotification", "postIfAuthorized", "FAIL", "add failed", [
                        "error": error.localizedDescription,
                    ])
                } else {
                    AgenticIOSLog.info("AgenticLocalNotification", "postIfAuthorized", "DONE", "posted", [
                        "id": tag,
                    ])
                }
            }
        }
    }

    /// Remove a specific pending/delivered notification by tag.
    static func remove(tag: String) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [tag])
        center.removeDeliveredNotifications(withIdentifiers: [tag])
    }

    /// Clear any WalletConnect return notifications still on screen — called when
    /// the app returns to the foreground so a stale banner does not linger after
    /// the user is already back in Agentic.
    static func clearWalletConnectNotifications() {
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { requests in
            let ids = requests.map(\.identifier).filter { $0.hasPrefix(walletConnectPrefix) }
            if !ids.isEmpty { center.removePendingNotificationRequests(withIdentifiers: ids) }
        }
        center.getDeliveredNotifications { notifications in
            let ids = notifications.map(\.request.identifier).filter { $0.hasPrefix(walletConnectPrefix) }
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }
}
