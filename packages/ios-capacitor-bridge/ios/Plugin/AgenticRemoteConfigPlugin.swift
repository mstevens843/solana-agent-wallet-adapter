import Capacitor
import Foundation

@objc(AgenticRemoteConfigPlugin)
public class AgenticRemoteConfigPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticRemoteConfigPlugin"
    public let jsName = "AgenticRemoteConfig"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]

    // Phase 2 implements the Swift port of
    // apps/android-twa/.../config/RemoteConfigLoader.kt and
    // apps/android-twa/.../config/RemoteConfigSchema.kt, backed by Keychain
    // (via AgenticSecureStatePlugin's store) and hitting /api/mobile-config?platform=ios.

    @objc func get(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        AgenticRemoteConfigStore.shared.respondGet(call)
    }

    @objc func refresh(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        let force = call.getBool("force", false)
        AgenticRemoteConfigStore.shared.refresh(force: force) { snapshot in
            call.resolve(snapshot.statusJson())
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        call.resolve(AgenticRemoteConfigStore.shared.snapshot.statusJson())
    }
}
