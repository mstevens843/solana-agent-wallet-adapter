import Foundation
import SwiftUI

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
final class AgenticWalletController: ObservableObject {
    @Published var selectedWalletID: AgenticWalletID = .phantom
    @Published var selectedCluster: AgenticCluster = .mainnetBeta
    @Published private(set) var currentRecord: AgenticAuthRecord?
    @Published private(set) var cacheCount = 0
    @Published private(set) var status = "Idle"
    @Published private(set) var lastError: String?
    @Published private(set) var pendingRequest: AgenticPendingRequest?
    @Published private(set) var lastSignature: String?

    private let cache = AgenticAuthCache()
    private let deepLinkService = AgenticDeepLinkService()

    init() {
        refreshCacheSummary()
        reconnectCached()
    }

    var walletOptions: [AgenticWalletDescriptor] {
        AgenticWalletID.allCases.map(\.descriptor)
    }

    var selectedWallet: AgenticWalletDescriptor {
        selectedWalletID.descriptor
    }

    func connect() {
        clearError()
        do {
            guard selectedWallet.transport == .encryptedDeeplink else {
                throw AgenticWalletError.walletConnectNotConfigured
            }
            let built = try deepLinkService.makeConnectRequest(walletID: selectedWalletID, cluster: selectedCluster)
            pendingRequest = built.request
            status = "Opening \(selectedWallet.name)"
            openURL(built.url)
            AgenticIOSNativeLog.info("AgenticWalletController", "connect", "START", "wallet connect launched", [
                "wallet": selectedWalletID.rawValue,
                "cluster": selectedCluster.rawValue,
                "requestId": built.request.id,
            ])
        } catch {
            fail("connect", error)
        }
    }

    func signDemoMessage() {
        clearError()
        do {
            guard let record = currentRecord else {
                throw AgenticWalletError.missingCachedAuthorization
            }
            guard record.walletID != .jupiter else {
                throw AgenticWalletError.walletConnectNotConfigured
            }
            let message = Data("Approve this Solana agent action with user custody.".utf8)
            let built = try deepLinkService.makeSignMessageRequest(message: message, record: record)
            pendingRequest = built.request
            status = "Opening \(record.walletName) for signing"
            openURL(built.url)
            AgenticIOSNativeLog.info("AgenticWalletController", "signDemoMessage", "START", "wallet sign launched", [
                "wallet": record.walletID.rawValue,
                "requestId": built.request.id,
            ])
        } catch {
            fail("signDemoMessage", error)
        }
    }

    func handleOpenURL(_ url: URL) {
        clearError()
        do {
            guard let pending = pendingRequest else {
                throw AgenticWalletError.invalidCallback("No pending iOS request matched the callback.")
            }
            let phase = callbackPhase(url)
            guard phase == pending.phase else {
                throw AgenticWalletError.invalidCallback("iOS callback phase did not match the pending request.")
            }
            switch pending.phase {
            case .connect:
                let record = try deepLinkService.completeConnect(callbackURL: url, pending: pending)
                currentRecord = record
                cache.set(record)
                pendingRequest = nil
                status = "Connected"
                refreshCacheSummary()
            case .sign:
                guard let record = currentRecord else {
                    throw AgenticWalletError.missingCachedAuthorization
                }
                let result = try deepLinkService.completeSigning(callbackURL: url, record: record)
                lastSignature = result.signatureBase58
                pendingRequest = nil
                status = "Signed"
            }
            AgenticIOSNativeLog.info("AgenticWalletController", "handleOpenURL", "SUCCESS", "callback handled", [
                "phase": pending.phase.rawValue,
                "requestId": pending.id,
            ])
        } catch {
            fail("handleOpenURL", error)
        }
    }

    func reconnectCached() {
        clearError()
        guard var record = cache.latest(walletID: selectedWalletID) ?? cache.latest() else {
            status = "No cached authorization"
            refreshCacheSummary()
            AgenticIOSNativeLog.info("AgenticWalletController", "reconnectCached", "SKIP", "no cached authorization")
            return
        }
        record.cluster = selectedCluster
        record.authenticated = true
        record.timestampUnixSeconds = nowSeconds()
        currentRecord = record
        cache.set(record)
        status = "Reconnected from cache"
        refreshCacheSummary()
        AgenticIOSNativeLog.info("AgenticWalletController", "reconnectCached", "SUCCESS", "cached authorization restored", [
            "wallet": record.walletID.rawValue,
            "pubkey": short(record.publicKey),
        ])
    }

    func disconnect() {
        if var record = currentRecord {
            record.authenticated = false
            record.timestampUnixSeconds = nowSeconds()
            cache.set(record)
        }
        currentRecord = nil
        pendingRequest = nil
        status = "Disconnected; cache retained"
        AgenticIOSNativeLog.info("AgenticWalletController", "disconnect", "DONE", "local session disconnected with cache retained")
        refreshCacheSummary()
    }

    func clearTransientState(reason: String = "manual") {
        pendingRequest = nil
        status = "Transient state cleared"
        AgenticIOSNativeLog.info("AgenticWalletController", "clearTransientState", "DONE", "transient state cleared", [
            "reason": reason,
        ])
    }

    func clearStateFullReset(reason: String = "manual") {
        let publicKey = currentRecord?.publicKey ?? cache.latest(walletID: selectedWalletID)?.publicKey
        pendingRequest = nil
        currentRecord = nil
        if let publicKey {
            cache.clear(publicKey: publicKey)
        }
        status = "Authorization cleared"
        AgenticIOSNativeLog.info("AgenticWalletController", "clearStateFullReset", "DONE", "authorization cleared", [
            "reason": reason,
            "pubkey": short(publicKey ?? ""),
        ])
        refreshCacheSummary()
    }

    func clearAllCachedAuthorizations() {
        pendingRequest = nil
        currentRecord = nil
        cache.clearAll()
        status = "All cached authorizations cleared"
        refreshCacheSummary()
    }

    private func refreshCacheSummary() {
        let summary = cache.summary()
        cacheCount = summary.count
    }

    private func callbackPhase(_ url: URL) -> AgenticPendingPhase? {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let phase = components?.queryItems?.first(where: { $0.name == "phase" })?.value,
           let parsed = AgenticPendingPhase(rawValue: phase) {
            return parsed
        }
        if url.path.hasSuffix("/connect") {
            return .connect
        }
        if url.path.hasSuffix("/sign") {
            return .sign
        }
        return nil
    }

    private func openURL(_ url: URL) {
        #if os(iOS)
        UIApplication.shared.open(url)
        #elseif os(macOS)
        NSWorkspace.shared.open(url)
        #endif
    }

    private func fail(_ method: String, _ error: Error) {
        lastError = error.localizedDescription
        status = "Error"
        AgenticIOSNativeLog.fail("AgenticWalletController", method, "FAIL", error.localizedDescription)
    }

    private func clearError() {
        lastError = nil
    }

    private func nowSeconds() -> Int {
        Int(Date().timeIntervalSince1970)
    }

    private func short(_ value: String, prefix: Int = 8, suffix: Int = 8) -> String {
        if value.count <= prefix + suffix {
            return value
        }
        return "\(value.prefix(prefix))...\(value.suffix(suffix))"
    }
}
