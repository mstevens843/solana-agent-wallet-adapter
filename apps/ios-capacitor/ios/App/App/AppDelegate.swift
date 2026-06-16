import UIKit
import WebKit
import Capacitor
import CapApp_SPM
import SystemConfiguration
import SolanaAgentWalletAdapterIosCapacitorBridge

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    // Set once the app has been backgrounded, so the WKWebView content-process liveness probe in
    // applicationDidBecomeActive runs only on a RETURN from background — not on first launch, where
    // the page is still loading and a probe could trigger a spurious reload.
    private var didBackgroundAtLeastOnce = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAgenticFirebaseAnalytics()
        // Bootstrap the native bridge: hydrates remote config from Keychain cache,
        // kicks a non-blocking refresh, prepares background-task plumbing.
        AgenticBridge.initialize()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        AgenticBridge.willResignActive()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Reserved for Phase 3 (DeviceAgent in-flight snapshot) and Phase 4
        // (streaming session checkpoint).
        didBackgroundAtLeastOnce = true
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // No-op; applicationDidBecomeActive carries the refresh trigger.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Mirrors Android MainActivity.onResume — refresh remote config (debounced
        // 60s in-store). Future phases drain in-flight DeviceAgent requests here.
        AgenticBridge.didBecomeActive()
        if didBackgroundAtLeastOnce {
            recoverWebViewIfContentProcessTerminated()
        }
        recoverRemoteWebViewURLIfNeeded()
    }

    /// Recover from a terminated WKWebView content process. iOS reclaims the web-content process of
    /// a backgrounded app under memory pressure; on return the WebView is blank/black and Capacitor's
    /// delegate logs the termination but does not reload. We probe the live JS context and reload
    /// ONLY when it's actually dead, so a healthy resume is left untouched. This is the iOS analog of
    /// the Android onRenderProcessGone recovery.
    private func recoverWebViewIfContentProcessTerminated() {
        guard let webView = (window?.rootViewController as? CAPBridgeViewController)?.webView else {
            return
        }
        webView.evaluateJavaScript("true") { _, error in
            guard error != nil else { return }
            NSLog("%@", "[AgentIOSApp] [AppDelegate] webContentProbe | RECOVER phase=WARN message=\"WKWebView content process appears terminated; reloading\"")
            webView.reload()
        }
    }

    /// If a live-mode build cold-launched into the bundled offline fallback, bring
    /// it back to the configured Render shell once the app is foregrounded with a
    /// reachable live host. This deliberately runs after the content-process probe
    /// and uses the web app's wallet-request guard so return-from-wallet flows are
    /// not interrupted.
    private func recoverRemoteWebViewURLIfNeeded() {
        guard let controller = window?.rootViewController as? AgenticBridgeViewController else {
            return
        }
        controller.recoverRemoteWebViewURLIfNeeded()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        let walletConnectHandled = AgenticBridge.handleOpenUrl(url)
        let capacitorHandled = ApplicationDelegateProxy.shared.application(app, open: url, options: options)
        // AgenticIOSLog is internal to the bridge module; use NSLog with the same
        // greppable prefix so this OS-entry log joins the idevicesyslog stream.
        // capacitorHandled=true means Capacitor fired its appUrlOpen JS event.
        NSLog("%@", "[AgentIOSApp] [AppDelegate] openURL | INBOUND phase=INFO message=\"app opened via custom-scheme URL\" scheme=\(url.scheme ?? "none") wcHandled=\(walletConnectHandled) capacitorHandled=\(capacitorHandled)")
        return walletConnectHandled || capacitorHandled
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        let walletConnectHandled = AgenticBridge.handleUserActivity(userActivity)
        let capacitorHandled = ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
        NSLog("%@", "[AgentIOSApp] [AppDelegate] continueUserActivity | INBOUND phase=INFO message=\"app opened via universal link\" type=\(userActivity.activityType) host=\(userActivity.webpageURL?.host ?? "none") wcHandled=\(walletConnectHandled) capacitorHandled=\(capacitorHandled)")
        return walletConnectHandled || capacitorHandled
    }

}

/// Root web container. Live-loads the UI from `server.url`
/// (https://agentic-signer.com) so Render deploys update the app with no new
/// App Store build — the iOS counterpart to the Android WebView shell.
///
/// OFFLINE FALLBACK (mirrors Android's `maybeFallbackToBundled`,
/// apps/android-twa/.../MainActivity.kt): if the live origin is unreachable when
/// the app cold-launches (airplane mode, no signal), we null out the remote
/// `serverURL` so Capacitor serves the bundled `webDir` copy from
/// capacitor://localhost instead of showing a blank screen. The next launch with
/// connectivity, or a foreground retry after connectivity returns, loads the
/// live Render bundle again. Both origins are trusted by AgenticBridgeOrigin.swift,
/// so the native plugins work in either state.
///
/// Wired in Base.lproj/Main.storyboard (customClass=AgenticBridgeViewController,
/// module=App). Lives in this already-compiled file so no new target/source
/// entry is needed.
///
/// Note: launch-time reachability covers the device-offline case. If the device
/// is online but Render itself is unreachable mid-session, the WebView shows the
/// remote error rather than auto-falling-back; Render's health check + fast
/// redeploys keep that window small.
final class AgenticBridgeViewController: CAPBridgeViewController {
    private static let appBackgroundColor = UIColor(
        red: 5.0 / 255.0,
        green: 7.0 / 255.0,
        blue: 6.0 / 255.0,
        alpha: 1.0
    )

    override var preferredStatusBarStyle: UIStatusBarStyle {
        .lightContent
    }

    private var configuredLiveServerURL: String?
    private var launchedWithBundledFallback = false
    private var fallbackRecoveryRetryCount = 0
    private var fallbackRecoveryRetryScheduled = false
    private static let fallbackRecoveryRetryInterval: TimeInterval = 15

    override func viewDidLoad() {
        super.viewDidLoad()
        applyAppBackground()
        webView?.scrollView.bounces = false
        webView?.scrollView.alwaysBounceVertical = false
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        applyAppBackground()
        setNeedsStatusBarAppearanceUpdate()
        if launchedWithBundledFallback {
            scheduleFallbackRecoveryRetry()
        }
    }

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let server = descriptor.serverURL {
            configuredLiveServerURL = server
        }
        if let server = descriptor.serverURL,
           let host = URL(string: server)?.host,
           !AgenticBridgeViewController.isHostReachable(host) {
            NSLog("%@", "[AgentIOSApp] [BridgeVC] instanceDescriptor | FALLBACK phase=WARN message=\"live origin unreachable at launch; serving bundled webDir\" host=\(host)")
            launchedWithBundledFallback = true
            descriptor.serverURL = nil
        }
        return descriptor
    }

    func recoverRemoteWebViewURLIfNeeded() {
        guard let liveURL = configuredLiveServerURL,
              let webView else {
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self, weak webView] in
            guard let self,
                  let webView else {
                return
            }
            self.webWalletRequestActive(webView: webView) { walletRequestActive in
                guard let host = URL(string: liveURL)?.host else {
                    return
                }
                let currentUrl = webView.url?.absoluteString
                if currentUrl == nil && !self.launchedWithBundledFallback {
                    return
                }
                let decision = AgenticWebViewRecoveryPolicy.decision(
                    liveUrl: liveURL,
                    currentUrl: currentUrl,
                    walletRequestActive: walletRequestActive,
                    liveHostReachable: Self.isHostReachable(host)
                )
                guard decision.shouldReload,
                      let url = URL(string: liveURL) else {
                    if self.launchedWithBundledFallback {
                        self.scheduleFallbackRecoveryRetry()
                    }
                    return
                }
                self.launchedWithBundledFallback = false
                NSLog("%@", "[AgentIOSApp] [BridgeVC] foregroundLiveUrlRecovery | RELOAD phase=WARN message=\"foregrounded on fallback or unexpected WebView URL; loading live Render shell\" reason=\(decision.reason) liveUrl=\(liveURL) currentUrl=\(webView.url?.absoluteString ?? "nil")")
                webView.load(URLRequest(url: url))
            }
        }
    }

    private func scheduleFallbackRecoveryRetry() {
        guard launchedWithBundledFallback,
              !fallbackRecoveryRetryScheduled else {
            return
        }
        fallbackRecoveryRetryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.fallbackRecoveryRetryInterval) { [weak self] in
            guard let self else { return }
            self.fallbackRecoveryRetryScheduled = false
            guard self.launchedWithBundledFallback else { return }
            self.fallbackRecoveryRetryCount += 1
            guard UIApplication.shared.applicationState == .active else { return }
            self.recoverRemoteWebViewURLIfNeeded()
        }
    }

    private func webWalletRequestActive(webView: WKWebView, completion: @escaping (Bool) -> Void) {
        let script = """
        (() => {
          const fn = window.__agenticNativeLiveUpdateRequestActive;
          return typeof fn === 'function' ? Boolean(fn()) : false;
        })()
        """
        webView.evaluateJavaScript(script) { value, error in
            if error != nil {
                completion(false)
                return
            }
            completion((value as? Bool) == true)
        }
    }

    private func applyAppBackground() {
        let background = Self.appBackgroundColor
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = background
        view.window?.backgroundColor = background
        webView?.backgroundColor = background
        webView?.isOpaque = false
        webView?.scrollView.backgroundColor = background
        if #available(iOS 15.0, *) {
            webView?.underPageBackgroundColor = background
        }
    }

    /// Synchronous route-availability check (no server round-trip). Returns false
    /// when there is no usable network path to `host`, which is the signal to fall
    /// back to the bundled assets.
    private static func isHostReachable(_ host: String) -> Bool {
        guard let reachability = SCNetworkReachabilityCreateWithName(nil, host) else {
            return false
        }
        var flags = SCNetworkReachabilityFlags()
        guard SCNetworkReachabilityGetFlags(reachability, &flags) else {
            return false
        }
        return flags.contains(.reachable) && !flags.contains(.connectionRequired)
    }
}
