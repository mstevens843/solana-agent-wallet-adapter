import Capacitor
import Foundation
import UIKit

@objc(AgenticWalletConnectPlugin)
public class AgenticWalletConnectPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticWalletConnectPlugin"
    public let jsName = "AgenticWalletConnect"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "wcConnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcLaunchWallet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcWaitForSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcGetSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcSignMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcSignTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcSignAndSendTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcDisconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcClearState", returnType: CAPPluginReturnPromise),
    ]

    @objc func wcConnect(_ call: CAPPluginCall) {
        rejectReown(call, method: "wcConnect")
    }

    @objc func wcLaunchWallet(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), let url = URL(string: uri) else {
            call.reject("Missing or invalid WalletConnect URI.", "INVALID_URI")
            return
        }
        AgenticIOSLog.info("AgenticWalletConnect", "wcLaunchWallet", "START", "opening WalletConnect URI", [
            "walletId": call.getString("walletId", "jupiter"),
            "uriBytes": String(uri.utf8.count),
        ])
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { launched in
                AgenticIOSLog.info("AgenticWalletConnect", "wcLaunchWallet", "DONE", "wallet launch attempted", [
                    "launched": String(launched),
                ])
                call.resolve(["launched": launched])
            }
        }
    }

    @objc func wcWaitForSession(_ call: CAPPluginCall) {
        rejectReown(call, method: "wcWaitForSession")
    }

    @objc func wcGetSession(_ call: CAPPluginCall) {
        AgenticIOSLog.info("AgenticWalletConnect", "wcGetSession", "DONE", "no native WalletConnect session available")
        call.resolve(["connected": false])
    }

    @objc func wcSignMessage(_ call: CAPPluginCall) {
        rejectReown(call, method: "wcSignMessage")
    }

    @objc func wcSignTransaction(_ call: CAPPluginCall) {
        rejectReown(call, method: "wcSignTransaction")
    }

    @objc func wcSignAndSendTransaction(_ call: CAPPluginCall) {
        rejectReown(call, method: "wcSignAndSendTransaction")
    }

    @objc func wcDisconnect(_ call: CAPPluginCall) {
        AgenticIOSLog.info("AgenticWalletConnect", "wcDisconnect", "DONE", "native WalletConnect state cleared")
        call.resolve(["disconnected": true])
    }

    @objc func wcClearState(_ call: CAPPluginCall) {
        AgenticIOSLog.info("AgenticWalletConnect", "wcClearState", "DONE", "native WalletConnect state cleared")
        call.resolve(["cleared": true])
    }

    private func rejectReown(_ call: CAPPluginCall, method: String) {
        let message = "Jupiter WalletConnect requires the Reown iOS SDK bridge for \(method)."
        AgenticIOSLog.fail("AgenticWalletConnect", method, "FAIL", message)
        call.reject(message, "WC_REOWN_NOT_CONFIGURED")
    }
}
