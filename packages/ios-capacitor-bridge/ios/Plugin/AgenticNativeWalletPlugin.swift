import Capacitor
import Foundation
import SolanaWalletAdapter

/// JS-callable surface for the native IWA wallet adapter (Phantom / Solflare /
/// Backpack). Thin wrapper over `AgenticNativeWalletCore`; every method
/// origin-gates, hops to the main actor (the underlying `WalletAdapterClient`
/// is `@MainActor`), and resolves/rejects the Capacitor promise.
///
/// Jupiter is NOT handled here — it stays on `AgenticWalletConnectPlugin`.
@objc(AgenticNativeWalletPlugin)
public class AgenticNativeWalletPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticNativeWalletPlugin"
    public let jsName = "AgenticNativeWallet"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signAllTransactions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signAndSendTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAllState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPending", returnType: CAPPluginReturnPromise),
    ]

    private let core = AgenticNativeWalletCore.shared

    @objc func connect(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let walletId = call.getString("walletId") else {
            call.reject("Missing walletId.", "INVALID_PARAMS")
            return
        }
        let cluster = call.getString("cluster") ?? "mainnet-beta"
        Task { @MainActor in
            do {
                let pubkey = try await self.core.connect(walletId: walletId, cluster: cluster)
                call.resolve(["publicKey": pubkey])
            } catch {
                self.reject(call, method: "connect", error)
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        Task { @MainActor in
            do {
                try await self.core.disconnect()
                call.resolve(["ok": true])
            } catch {
                self.reject(call, method: "disconnect", error)
            }
        }
    }

    @objc func getSession(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        Task { @MainActor in
            if let session = self.core.currentSession() {
                call.resolve(["connected": true, "publicKey": session.publicKey, "walletId": session.walletId])
            } else {
                call.resolve(["connected": false])
            }
        }
    }

    @objc func resumeSession(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let walletId = call.getString("walletId") else {
            call.reject("Missing walletId.", "INVALID_PARAMS")
            return
        }
        let cluster = call.getString("cluster") ?? "mainnet-beta"
        Task { @MainActor in
            do {
                if let pubkey = try await self.core.resumeSession(walletId: walletId, cluster: cluster) {
                    call.resolve(["connected": true, "publicKey": pubkey])
                } else {
                    call.resolve(["connected": false])
                }
            } catch {
                self.reject(call, method: "resumeSession", error)
            }
        }
    }

    @objc func signMessage(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let message = call.getString("message") else {
            call.reject("Missing message.", "INVALID_PARAMS")
            return
        }
        Task { @MainActor in
            do {
                let signature = try await self.core.signMessage(messageBase64: message)
                call.resolve(["signature": signature, "signatureEncoding": "base58"])
            } catch {
                self.reject(call, method: "signMessage", error)
            }
        }
    }

    @objc func signTransaction(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let transaction = call.getString("transaction") else {
            call.reject("Missing transaction.", "INVALID_PARAMS")
            return
        }
        Task { @MainActor in
            do {
                let signed = try await self.core.signTransaction(transactionBase64: transaction)
                call.resolve(["signature": signed, "transactionEncoding": "base64"])
            } catch {
                self.reject(call, method: "signTransaction", error)
            }
        }
    }

    @objc func signAllTransactions(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let transactions = call.getArray("transactions", String.self), !transactions.isEmpty else {
            call.reject("Missing transactions.", "INVALID_PARAMS")
            return
        }
        Task { @MainActor in
            do {
                let signed = try await self.core.signAllTransactions(transactionsBase64: transactions)
                call.resolve(["transactions": signed, "transactionEncoding": "base64"])
            } catch {
                self.reject(call, method: "signAllTransactions", error)
            }
        }
    }

    @objc func signAndSendTransaction(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        guard let transaction = call.getString("transaction") else {
            call.reject("Missing transaction.", "INVALID_PARAMS")
            return
        }
        Task { @MainActor in
            do {
                let txid = try await self.core.signAndSendTransaction(transactionBase64: transaction)
                call.resolve(["signature": txid, "txid": txid])
            } catch {
                self.reject(call, method: "signAndSendTransaction", error)
            }
        }
    }

    @objc func clearState(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        Task { @MainActor in
            do {
                try await self.core.clearState()
                call.resolve(["cleared": true])
            } catch {
                self.reject(call, method: "clearState", error)
            }
        }
    }

    // Native IWA persistence is a single active-session record, so a full reset is
    // the same Keychain wipe as clearState. Exposed separately to match the JS
    // maintenance surface (clearAllCachedAuthorizations).
    @objc func clearAllState(_ call: CAPPluginCall) {
        clearState(call)
    }

    // Release the native single-flight pending slot so an abandoned/lost wallet
    // round-trip stops blocking later actions. Does not drop the session.
    @objc func cancelPending(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        Task { @MainActor in
            self.core.cancelPending()
            call.resolve(["cancelled": true])
        }
    }

    private func reject(_ call: CAPPluginCall, method: String, _ error: Error) {
        let code: String
        let message: String
        if let core = error as? AgenticNativeWalletCore.CoreError {
            code = core.code
            message = core.localizedDescription
        } else if let walletError = error as? WalletAdapterError {
            // Stable, terse user-facing copy from the IWA package
            // (e.g. "Rejected in wallet", "Session expired — reconnect").
            code = "NATIVE_WALLET_ADAPTER_ERROR"
            message = walletError.userMessage
        } else {
            code = "NATIVE_WALLET_ERROR"
            message = error.localizedDescription
        }
        AgenticIOSLog.fail("AgenticNativeWallet", method, "FAIL", message, ["code": code])
        call.reject(message, code)
    }
}
