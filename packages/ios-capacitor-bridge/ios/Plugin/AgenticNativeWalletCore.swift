import Foundation
import UIKit
import SolanaWalletAdapter
import SolanaWalletAdapterUI

/// Bridges the native IWA `WalletAdapterClient` (the shipped
/// `ios-solana-wallet-adapter` Swift package) into the Capacitor app for
/// Phantom / Solflare / Backpack. Jupiter is intentionally NOT routed here —
/// it stays on `AgenticWalletConnectCore` (Reown WalletConnect).
///
/// One client instance is reused across wallets via `selectProvider`, so a
/// single Keychain-persisted session and a single pending-request slot back
/// every signing surface in the app. All mutable state is confined to the main
/// actor (`WalletAdapterClient` is `@MainActor`); `handleCallback` is the only
/// nonisolated entry point and it merely hops a non-blocking `Task` to main.
final class AgenticNativeWalletCore: @unchecked Sendable {
    static let shared = AgenticNativeWalletCore()

    enum CoreError: Error, LocalizedError {
        case notConnected
        case unknownWallet(String)
        case badPayload(String)

        var errorDescription: String? {
            switch self {
            case .notConnected:
                return "No native wallet is connected. Connect a wallet first."
            case let .unknownWallet(id):
                return "Unsupported native wallet id: \(id)."
            case let .badPayload(detail):
                return "Malformed signing payload: \(detail)."
            }
        }

        var code: String {
            switch self {
            case .notConnected: return "NATIVE_WALLET_NOT_CONNECTED"
            case .unknownWallet: return "NATIVE_WALLET_UNKNOWN_WALLET"
            case .badPayload: return "NATIVE_WALLET_BAD_PAYLOAD"
            }
        }
    }

    // The IWA callback host. Distinct from the WalletConnect envelope path so
    // `handleCallback` never swallows a Reown/Jupiter return or any other
    // `agenticwallet://` deep link. Kept in sync with the JS redirect builder.
    static let callbackHost = "iwa-callback"

    /// Wall-clock backstop for a wallet round-trip. If the wallet never returns a
    /// callback (user backs out; wallet shows its own error and doesn't deep-link
    /// back), the watchdog cancels the native single-flight `pending` slot so the
    /// next action isn't blocked by "Another request is in progress". Set above
    /// the JS-side TTL (120s) so the JS layer gets first chance to recover.
    private static let pendingTimeoutNanos: UInt64 = 150_000_000_000

    private var client: WalletAdapterClient?
    private var currentWalletId: String?

    private init() {}

    /// Touch-to-warm so the singleton exists before any cold-start wallet
    /// callback arrives (the wallet app may relaunch us). Cheap and idempotent;
    /// the underlying `WalletAdapterClient` is still built lazily on first connect.
    func warm() {}

    // MARK: - Lifecycle

    @MainActor
    func connect(walletId: String, cluster clusterString: String) async throws -> String {
        let cluster = Self.cluster(from: clusterString)
        let client = try ensureClient(walletId: walletId, cluster: cluster)
        AgenticIOSLog.info("AgenticNativeWallet", "connect", "START", "native connect requested", [
            "walletId": walletId,
            "cluster": cluster.rawValue,
        ])
        let session = try await withPendingTimeout("connect") { try await client.connect(cluster: cluster) }
        AgenticIOSLog.info("AgenticNativeWallet", "connect", "DONE", "native wallet connected", [
            "walletId": walletId,
            "pubkey": WalletAdapterDebugFormatter.shortBase58(session.userPublicKey),
        ])
        return session.userPublicKey
    }

    /// Restore a Keychain-cached session without a wallet round-trip. Returns the
    /// connected public key, or nil when there is nothing usable to resume.
    @MainActor
    func resumeSession(walletId: String, cluster clusterString: String) async throws -> String? {
        let cluster = Self.cluster(from: clusterString)
        let client = try ensureClient(walletId: walletId, cluster: cluster)
        let resumed = await client.resumeCachedSession()
        let pubkey = client.adapter.session?.userPublicKey
        AgenticIOSLog.info("AgenticNativeWallet", "resumeSession", resumed ? "DONE" : "SKIP", "cached session resume attempted", [
            "walletId": walletId,
            "resumed": String(resumed),
        ])
        return resumed ? pubkey : nil
    }

    @MainActor
    func currentSession() -> (walletId: String, publicKey: String)? {
        guard let walletId = currentWalletId, let pubkey = client?.adapter.session?.userPublicKey else {
            return nil
        }
        return (walletId, pubkey)
    }

    @MainActor
    func disconnect() async throws {
        try await client?.disconnect()
        AgenticIOSLog.info("AgenticNativeWallet", "disconnect", "DONE", "native wallet disconnected")
    }

    @MainActor
    func clearState() async throws {
        try await client?.clearState()
        currentWalletId = nil
        AgenticIOSLog.info("AgenticNativeWallet", "clearState", "DONE", "native wallet state cleared")
    }

    /// Release the native single-flight `pending` slot WITHOUT dropping the
    /// session, so a lost/abandoned round-trip can be cleared from JS (or the
    /// watchdog) instead of forcing an app restart.
    @MainActor
    func cancelPending() {
        let cancelled = client?.cancelPendingRequest() ?? false
        AgenticIOSLog.info("AgenticNativeWallet", "cancelPending", cancelled ? "DONE" : "SKIP", "release native pending slot requested", [
            "cancelled": String(cancelled),
        ])
    }

    // MARK: - Signing

    /// Returns the message signature, base58-encoded — matches the encoding the
    /// existing JS backend reports for `SigningResult.signature` on sign_message.
    @MainActor
    func signMessage(messageBase64: String) async throws -> String {
        let client = try requireClient()
        let message = try Self.decodeBase64(messageBase64, field: "message")
        let result = try await withPendingTimeout("signMessage") { try await client.signMessage(message) }
        return AgenticBase58.encode(result.signature)
    }

    /// Returns the signed transaction wire bytes, base64-encoded — matches the
    /// existing JS backend's `SigningResult.signature` on sign_transaction.
    @MainActor
    func signTransaction(transactionBase64: String) async throws -> String {
        let client = try requireClient()
        let transaction = try Self.decodeBase64(transactionBase64, field: "transaction")
        let result = try await withPendingTimeout("signTransaction") { try await client.signTransaction(transaction) }
        return result.transaction.base64EncodedString()
    }

    @MainActor
    func signAllTransactions(transactionsBase64: [String]) async throws -> [String] {
        let client = try requireClient()
        let transactions = try transactionsBase64.map { try Self.decodeBase64($0, field: "transaction") }
        let result = try await withPendingTimeout("signAllTransactions") { try await client.signAllTransactions(transactions) }
        return result.transactions.map { $0.base64EncodedString() }
    }

    /// Returns the broadcast signature (txid), base58 — matches the existing JS
    /// backend's `SigningResult.signature` on sign_and_send_transaction.
    @MainActor
    func signAndSendTransaction(transactionBase64: String) async throws -> String {
        let client = try requireClient()
        let transaction = try Self.decodeBase64(transactionBase64, field: "transaction")
        let result = try await withPendingTimeout("signAndSendTransaction") { try await client.signAndSendTransaction(transaction) }
        return result.signature
    }

    // MARK: - Callback routing

    /// Called from `AgenticBridge.handleOpenUrl` for every inbound URL that the
    /// WalletConnect envelope path did not consume. Returns true (synchronously)
    /// only for our dedicated callback host so Capacitor stops processing it; the
    /// actual continuation resume hops to the main actor in a non-blocking Task.
    func handleCallback(_ url: URL) -> Bool {
        guard url.host == Self.callbackHost else { return false }
        Task { @MainActor in
            let consumed = self.client?.handleOpenURL(url) ?? false
            AgenticIOSLog.info("AgenticNativeWallet", "handleCallback", consumed ? "RESUMED" : "NO_PENDING", "native wallet callback routed", [
                "host": url.host ?? "none",
                "path": url.path,
            ])
        }
        return true
    }

    // MARK: - Internals

    @MainActor
    private func ensureClient(walletId: String, cluster: Cluster) throws -> WalletAdapterClient {
        guard let provider = WalletProviderRegistry.provider(for: walletId) else {
            throw CoreError.unknownWallet(walletId)
        }
        if let existing = client {
            if currentWalletId != walletId {
                try existing.selectProvider(provider, cluster: cluster)
                currentWalletId = walletId
            }
            return existing
        }
        // Build from any persisted Keychain state so the ephemeral encryption
        // keypair is restored ALONGSIDE the session. `resumeCachedSession` reloads
        // only the session and assumes the client already holds the matching
        // keypair (see its docstring); building with a fresh `.generate()` keypair
        // here breaks that invariant and makes Backpack reject every sign with
        // INVALID_SESSION after a relaunch (it binds a session to the exact connect
        // keypair). When there is no persisted session, `restore` falls back to a
        // fresh-keypair client, identical to a first-time connect.
        let built = try WalletAdapterClient.restore(
            from: KeychainWalletAdapterStateStore(),
            fallbackProvider: provider,
            appURL: Self.appURL(),
            redirectLink: Self.redirectLink(),
            cluster: cluster,
            opener: UIKitWalletURLOpener(application: .shared)
        )
        client = built
        // `restore` adopts the persisted provider when a session exists. If that
        // differs from the requested wallet (a wallet switch), realign to the
        // requested provider; a switch needs a fresh connect anyway.
        let restoredWalletId = built.adapter.provider.walletId
        if restoredWalletId != walletId {
            try built.selectProvider(provider, cluster: cluster)
        }
        currentWalletId = walletId
        return built
    }

    @MainActor
    private func requireClient() throws -> WalletAdapterClient {
        guard let client else { throw CoreError.notConnected }
        return client
    }

    /// Run a wallet round-trip with a wall-clock watchdog. On success (or a
    /// wallet-returned error via callback) the watchdog is cancelled in `defer`.
    /// If the operation hangs past the deadline, the watchdog cancels the pending
    /// request, which resumes the awaiting continuation with `.requestCancelled`
    /// so `operation` throws instead of hanging forever.
    @MainActor
    private func withPendingTimeout<T>(_ label: String, _ operation: () async throws -> T) async throws -> T {
        let watchdog = Task { @MainActor in
            try? await Task.sleep(nanoseconds: Self.pendingTimeoutNanos)
            guard !Task.isCancelled else { return }
            let cancelled = self.client?.cancelPendingRequest() ?? false
            if cancelled {
                AgenticIOSLog.fail("AgenticNativeWallet", label, "TIMEOUT", "wallet round-trip exceeded deadline; cancelled pending request")
            }
        }
        defer { watchdog.cancel() }
        return try await operation()
    }

    private static func decodeBase64(_ value: String, field: String) throws -> Data {
        guard let data = Data(base64Encoded: value) else {
            throw CoreError.badPayload("\(field) is not valid base64")
        }
        return data
    }

    private static func cluster(from raw: String) -> Cluster {
        switch raw {
        case "devnet": return .devnet
        case "testnet": return .testnet
        case "localnet": return .devnet // iOS native wallets have no localnet; nearest safe default
        default: return .mainnetBeta
        }
    }

    private static func appURL() -> URL {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "AGENTIC_CLOUD_API_BASE_URL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let raw, !raw.isEmpty, let url = URL(string: raw) {
            return url
        }
        return URL(string: "https://agentic-signer.com")!
    }

    private static func redirectLink() -> URL {
        URL(string: "agenticwallet://\(callbackHost)")!
    }
}
