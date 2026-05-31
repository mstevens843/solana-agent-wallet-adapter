import UIKit
import Capacitor
import SolanaAgentWalletAdapterIosCapacitorBridge

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
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
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // No-op; applicationDidBecomeActive carries the refresh trigger.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Mirrors Android MainActivity.onResume — refresh remote config (debounced
        // 60s in-store). Future phases drain in-flight DeviceAgent requests here.
        AgenticBridge.didBecomeActive()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        let walletConnectHandled = AgenticBridge.handleOpenUrl(url)
        let capacitorHandled = ApplicationDelegateProxy.shared.application(app, open: url, options: options)
        return walletConnectHandled || capacitorHandled
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        let walletConnectHandled = AgenticBridge.handleUserActivity(userActivity)
        let capacitorHandled = ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
        return walletConnectHandled || capacitorHandled
    }

}
