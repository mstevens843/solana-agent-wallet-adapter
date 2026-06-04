import Capacitor
import Foundation
import UIKit

#if canImport(WalletConnectSign)
import WalletConnectSign
#endif

@objc(AgenticWalletConnectPlugin)
public class AgenticWalletConnectPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticWalletConnectPlugin"
    public let jsName = "AgenticWalletConnect"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "wcConnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcLaunchWallet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcReForeground", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcWaitForSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcGetSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcSignMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcSignTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcSignAndSendTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcDisconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wcClearState", returnType: CAPPluginReturnPromise),
    ]

    @objc func wcConnect(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            let cluster = call.getString("cluster") ?? "mainnet-beta"
            AgenticWalletConnectCore.shared.connect(cluster: cluster) { result in
                switch result {
                case .success(let pair):
                    call.resolve(["uri": pair.uri, "topic": pair.topic])
                case .failure(let err):
                    call.reject(err.localizedDescription, "WC_CONNECT_FAILED")
                }
            }
            return
        }
#endif
        rejectReown(call, method: "wcConnect")
    }

    @objc func wcLaunchWallet(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let uri = call.getString("uri") else {
            call.reject("Missing WalletConnect URI.", "INVALID_URI")
            return
        }
        let walletId = call.getString("walletId", "jupiter")
        let urls = walletConnectLaunchCandidates(uri: uri, walletId: walletId)
        guard !urls.isEmpty else {
            call.reject("Invalid WalletConnect URI.", "INVALID_URI")
            return
        }
        AgenticIOSLog.info("AgenticWalletConnect", "wcLaunchWallet", "START", "opening WalletConnect URI", [
            "walletId": walletId,
            "uriBytes": String(uri.utf8.count),
            "candidateCount": String(urls.count),
        ])
        openFirstWalletConnectCandidate(urls) { launched, launchedUrl in
            // Retain the opened pairing URL so a return to Agentic (didBecomeActive
            // or the manual "Open Jupiter again" button) can re-fire it if Jupiter
            // cold-dropped the deep link to its web home instead of pairing.
            if launched, let launchedUrl {
#if canImport(WalletConnectSign)
                if #available(iOS 16.0, *) {
                    AgenticWalletConnectCore.shared.setPendingPairingLaunch(url: launchedUrl)
                }
#endif
            }
            DispatchQueue.main.async {
                AgenticIOSLog.info("AgenticWalletConnect", "wcLaunchWallet", "DONE", "wallet launch attempted", [
                    "launched": String(launched),
                    "url": launchedUrl?.scheme ?? "none",
                ])
                call.resolve([
                    "launched": launched,
                    "url": launchedUrl?.absoluteString ?? "",
                ])
            }
        }
    }

    @objc func wcReForeground(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            AgenticIOSLog.info("AgenticWalletConnect", "wcReForeground", "START", "manual re-foreground requested")
            AgenticWalletConnectCore.shared.reForegroundPendingWalletIfNeeded(force: true)
            call.resolve(["ok": true])
            return
        }
#endif
        call.resolve(["ok": false])
    }

    @objc func wcWaitForSession(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            let timeout = call.getInt("timeoutMs") ?? 120_000
            AgenticWalletConnectCore.shared.waitForSession(timeoutMs: timeout) { result in
                switch result {
                case .success(let pair):
                    call.resolve(["pubkey": pair.pubkey, "topic": pair.topic])
                case .failure(let err):
                    call.reject(err.localizedDescription, "WC_WAIT_FAILED")
                }
            }
            return
        }
#endif
        rejectReown(call, method: "wcWaitForSession")
    }

    @objc func wcGetSession(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            if let session = AgenticWalletConnectCore.shared.currentSession() {
                call.resolve(["connected": true, "pubkey": session.pubkey, "topic": session.topic])
            } else {
                call.resolve(["connected": false])
            }
            return
        }
#endif
        AgenticIOSLog.info("AgenticWalletConnect", "wcGetSession", "DONE", "no native WalletConnect session available")
        call.resolve(["connected": false])
    }

    @objc func wcSignMessage(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            guard let pubkey = call.getString("pubkey"), let message = call.getString("message") else {
                call.reject("Missing pubkey or message.", "INVALID_PARAMS")
                return
            }
            AgenticWalletConnectCore.shared.signMessage(pubkey: pubkey, message: message) { result in
                switch result {
                case .success(let sig): call.resolve(["signature": sig])
                case .failure(let err): call.reject(err.localizedDescription, "WC_SIGN_MESSAGE_FAILED")
                }
            }
            return
        }
#endif
        rejectReown(call, method: "wcSignMessage")
    }

    @objc func wcSignTransaction(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            guard let pubkey = call.getString("pubkey"), let tx = call.getString("transaction") else {
                call.reject("Missing pubkey or transaction.", "INVALID_PARAMS")
                return
            }
            AgenticWalletConnectCore.shared.signTransaction(pubkey: pubkey, transaction: tx) { result in
                switch result {
                case .success(let resp):
                    var out: [String: Any] = ["transactionEncoding": "base64"]
                    if let sig = resp.signature { out["signature"] = sig }
                    if let t = resp.transaction { out["transaction"] = t }
                    call.resolve(out)
                case .failure(let err): call.reject(err.localizedDescription, "WC_SIGN_TX_FAILED")
                }
            }
            return
        }
#endif
        rejectReown(call, method: "wcSignTransaction")
    }

    @objc func wcSignAndSendTransaction(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            guard let pubkey = call.getString("pubkey"), let tx = call.getString("transaction") else {
                call.reject("Missing pubkey or transaction.", "INVALID_PARAMS")
                return
            }
            AgenticWalletConnectCore.shared.signAndSendTransaction(pubkey: pubkey, transaction: tx) { result in
                switch result {
                case .success(let resp):
                    var out: [String: Any] = ["signature": resp.signature]
                    if let id = resp.txid { out["txid"] = id }
                    call.resolve(out)
                case .failure(let err): call.reject(err.localizedDescription, "WC_SIGN_SEND_FAILED")
                }
            }
            return
        }
#endif
        rejectReown(call, method: "wcSignAndSendTransaction")
    }

    @objc func wcDisconnect(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            AgenticWalletConnectCore.shared.disconnect { ok in
                call.resolve(["disconnected": ok])
            }
            return
        }
#endif
        AgenticIOSLog.info("AgenticWalletConnect", "wcDisconnect", "DONE", "native WalletConnect state cleared")
        call.resolve(["disconnected": true])
    }

    @objc func wcClearState(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
#if canImport(WalletConnectSign)
        if #available(iOS 16.0, *) {
            AgenticWalletConnectCore.shared.clearState()
        }
#endif
        AgenticIOSLog.info("AgenticWalletConnect", "wcClearState", "DONE", "native WalletConnect state cleared")
        call.resolve(["cleared": true])
    }

    private func rejectReown(_ call: CAPPluginCall, method: String) {
        let message = "Jupiter WalletConnect requires the Reown iOS SDK. Add `https://github.com/reown-com/reown-swift.git` (from 1.0.0) to Package.swift and add `WalletConnect` to the bridge target's dependencies. See packages/ios-capacitor-bridge/ios/Plugin/AgenticWalletConnectCore.swift."
        AgenticIOSLog.fail("AgenticWalletConnect", method, "FAIL", message)
        call.reject(message, "WC_REOWN_NOT_CONFIGURED")
    }

    private func walletConnectLaunchCandidates(uri: String, walletId: String) -> [URL] {
        AgenticWalletConnectDeepLink.pairingLaunchCandidates(uri: uri, walletId: walletId)
    }

    private func openFirstWalletConnectCandidate(
        _ urls: [URL],
        completion: @escaping (Bool, URL?) -> Void
    ) {
        var remaining = urls
        guard !remaining.isEmpty else {
            completion(false, nil)
            return
        }
        let url = remaining.removeFirst()
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { launched in
                if launched {
                    completion(true, url)
                    return
                }
                self.openFirstWalletConnectCandidate(remaining, completion: completion)
            }
        }
    }
}
