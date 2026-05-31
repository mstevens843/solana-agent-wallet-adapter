// Reown SDK integration for AgenticWalletConnectPlugin. Gated by
// `#if canImport(WalletConnectSign)` so the bridge package compiles whether
// or not the (heavy: ~100MB) Reown deps are enabled.
//
// To enable:
//   1. Uncomment the Reown package dependency in Package.swift:
//        .package(url: "https://github.com/reown-com/reown-swift.git", from: "1.0.0"),
//      and add `.product(name: "WalletConnect", package: "reown-swift")` to the
//      bridge target's dependencies.
//   2. Set a Reown project id via the cloud's WALLETCONNECT_PROJECT_ID env var
//      so it ships in /api/mobile-config; the plugin reads it from
//      AgenticRemoteConfigStore on first use.
//   3. Rebuild via `pnpm copy-web && pnpm sync` from apps/ios-capacitor.
//
// The Solana namespace methods we require:
//   - solana_signMessage
//   - solana_signTransaction
// Optional, when a wallet advertises it:
//   - solana_signAndSendTransaction
//
// Reference: WalletConnect v2 spec (Solana namespace).
import Foundation

#if canImport(WalletConnectSign)
import WalletConnectSign
import WalletConnectPairing
import WalletConnectNetworking
import Commons
import Combine
import UIKit

@available(iOS 16.0, *)
final class AgenticWalletConnectCore {
    static let shared = AgenticWalletConnectCore()

    private var cancellables = Set<AnyCancellable>()
    private var configured = false
    private let queue = DispatchQueue(label: "com.agentic.wallet.walletconnect", qos: .userInitiated)
    private let walletConnectGroupIdentifier = "group.com.agentic.wallet"
    private var sessionPubkey: String?
    private var sessionTopic: String?
    private var sessionChainId: String?
    private var walletRedirectNative: String?
    private var walletRedirectUniversal: String?
    private var sessionWaiters: [UUID: (Result<(String, String), Error>) -> Void] = [:]

    private init() {}

    func ensureConfigured() throws {
        try queue.sync {
            if configured { return }
            let snapshot = AgenticRemoteConfigStore.shared.snapshot
            guard let projectId = snapshot.config.walletConnectProjectId, !projectId.isEmpty else {
                throw AgenticAgentError(code: "WC_NO_PROJECT_ID", message: "WalletConnect project id missing — set WALLETCONNECT_PROJECT_ID in cloud env.")
            }
            let redirect = try AppMetadata.Redirect(native: "agenticwallet://", universal: "https://agentic-signer.com")
            let metadata = AppMetadata(
                name: "Agentic",
                description: "Agentic Wallet Adapter",
                url: "https://agentic-signer.com",
                icons: ["https://agentic-signer.com/icons/agentic-512.png"],
                redirect: redirect
            )
            Networking.configure(
                groupIdentifier: walletConnectGroupIdentifier,
                projectId: projectId,
                socketFactory: AgenticWebSocketFactory()
            )
            Pair.configure(metadata: metadata)
            Sign.configure(crypto: AgenticWalletConnectCryptoProvider())
            // Subscribe to session lifecycle to surface to wcWaitForSession waiters.
            Sign.instance.sessionsPublisher
                .receive(on: queue)
                .sink { [weak self] sessions in
                    guard let self else { return }
                    guard let normalized = sessions.compactMap({ self.normalizeSession($0) }).first else {
                        if sessions.isEmpty { self.clearSessionStateLocked(reason: "sessions_empty") }
                        return
                    }
                    self.activateSession(normalized, source: "sessionsPublisher")
                }
                .store(in: &cancellables)
            Sign.instance.sessionSettlePublisher
                .receive(on: queue)
                .sink { [weak self] session in
                    guard let self else { return }
                    guard let normalized = self.normalizeSession(session) else {
                        AgenticIOSLog.fail("AgenticWalletConnect", "sessionSettle", "FAIL", "WalletConnect session did not contain a Solana account")
                        return
                    }
                    self.activateSession(normalized, source: "sessionSettlePublisher")
                }
                .store(in: &cancellables)
            Sign.instance.sessionDeletePublisher
                .receive(on: queue)
                .sink { [weak self] topic, _ in
                    guard let self else { return }
                    if topic == self.sessionTopic {
                        self.clearSessionStateLocked(reason: "session_deleted")
                    }
                }
                .store(in: &cancellables)
            if let restored = Sign.instance.getSessions().compactMap({ normalizeSession($0) }).first {
                activateSession(restored, source: "restore")
            }
            configured = true
        }
    }

    func connect(cluster: String, completion: @escaping (Result<(uri: String, topic: String), Error>) -> Void) {
        do {
            try ensureConfigured()
        } catch {
            completion(.failure(error))
            return
        }
        let chain = solanaChainId(for: cluster)
        queue.async {
            self.sessionChainId = chain
        }
        Task {
            do {
                let methods: Set<String> = ["solana_signMessage", "solana_signTransaction"]
                let optionalMethods: Set<String> = ["solana_signAndSendTransaction"]
                let events: Set<String> = ["chainChanged", "accountsChanged"]
                let blockchain = Blockchain(chain) ?? Blockchain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")!
                let namespace = ProposalNamespace(chains: [blockchain], methods: methods, events: events)
                let optionalNamespace = ProposalNamespace(chains: [blockchain], methods: optionalMethods, events: events)
                let uri = try await Sign.instance.connect(
                    requiredNamespaces: ["solana": namespace],
                    optionalNamespaces: ["solana": optionalNamespace]
                )
                completion(.success((uri: uri.absoluteString, topic: uri.topic)))
            } catch {
                completion(.failure(error))
            }
        }
    }

    func waitForSession(timeoutMs: Int, completion: @escaping (Result<(pubkey: String, topic: String), Error>) -> Void) {
        do { try ensureConfigured() } catch { completion(.failure(error)); return }
        queue.async {
            if let pubkey = self.sessionPubkey, !pubkey.isEmpty, let topic = self.sessionTopic {
                completion(.success((pubkey, topic)))
                return
            }
            let waiterId = UUID()
            self.sessionWaiters[waiterId] = { result in
                switch result {
                case .success(let pair): completion(.success((pubkey: pair.0, topic: pair.1)))
                case .failure(let err): completion(.failure(err))
                }
            }
            let timeout: DispatchTimeInterval = .milliseconds(timeoutMs)
            self.queue.asyncAfter(deadline: .now() + timeout) {
                if let waiter = self.sessionWaiters.removeValue(forKey: waiterId) {
                    waiter(.failure(AgenticAgentError(code: "WC_TIMEOUT", message: "WalletConnect session timed out.")))
                }
            }
        }
    }

    func currentSession() -> (pubkey: String, topic: String)? {
        guard (try? ensureConfigured()) != nil else { return nil }
        return queue.sync {
            guard let pubkey = sessionPubkey, !pubkey.isEmpty, let topic = sessionTopic else { return nil }
            return (pubkey, topic)
        }
    }

    func signMessage(pubkey: String, message: String, completion: @escaping (Result<String, Error>) -> Void) {
        do { try ensureConfigured() } catch { completion(.failure(error)); return }
        let topicResult = activeTopic(for: pubkey)
        guard case .success(let topic) = topicResult else {
            if case .failure(let error) = topicResult { completion(.failure(error)) }
            return
        }
        let params: [String: Any] = ["pubkey": pubkey, "message": message]
        sendRequest(topic: topic, method: "solana_signMessage", params: params) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                guard let signature = self.stringValue(data, keys: ["signature"]) else {
                    completion(.failure(AgenticAgentError(code: "WC_INVALID_RESPONSE", message: "Missing signature.")))
                    return
                }
                completion(.success(signature))
            }
        }
    }

    func signTransaction(pubkey: String, transaction: String, completion: @escaping (Result<(signature: String?, transaction: String?), Error>) -> Void) {
        do { try ensureConfigured() } catch { completion(.failure(error)); return }
        let topicResult = activeTopic(for: pubkey)
        guard case .success(let topic) = topicResult else {
            if case .failure(let error) = topicResult { completion(.failure(error)) }
            return
        }
        let params: [String: Any] = ["transaction": transaction]
        sendRequest(topic: topic, method: "solana_signTransaction", params: params) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                let signature = self.stringValue(data, keys: ["signature"])
                let tx = self.stringValue(data, keys: ["transaction"])
                guard signature != nil || tx != nil else {
                    completion(.failure(AgenticAgentError(code: "WC_INVALID_RESPONSE", message: "Missing signed transaction or signature.")))
                    return
                }
                completion(.success((signature: signature, transaction: tx)))
            }
        }
    }

    func signAndSendTransaction(pubkey: String, transaction: String, completion: @escaping (Result<(signature: String, txid: String?), Error>) -> Void) {
        do { try ensureConfigured() } catch { completion(.failure(error)); return }
        let topicResult = activeTopic(for: pubkey)
        guard case .success(let topic) = topicResult else {
            if case .failure(let error) = topicResult { completion(.failure(error)) }
            return
        }
        let params: [String: Any] = [
            "transaction": transaction,
            "sendOptions": [
                "skipPreflight": false,
                "preflightCommitment": "confirmed",
                "maxRetries": 3,
            ],
        ]
        sendRequest(topic: topic, method: "solana_signAndSendTransaction", params: params) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                let txid = self.stringValue(data, keys: ["txid", "signature"])
                guard let signature = self.stringValue(data, keys: ["signature", "txid"]) else {
                    completion(.failure(AgenticAgentError(code: "WC_INVALID_RESPONSE", message: "Missing transaction id.")))
                    return
                }
                completion(.success((signature: signature, txid: txid)))
            }
        }
    }

    func disconnect(completion: @escaping (Bool) -> Void) {
        do { try ensureConfigured() } catch {
            clearState()
            completion(true)
            return
        }
        queue.async {
            guard let topic = self.sessionTopic else { completion(true); return }
            Task {
                do {
                    try await Sign.instance.disconnect(topic: topic)
                    self.queue.async {
                        self.sessionPubkey = nil
                        self.sessionTopic = nil
                        self.sessionChainId = nil
                        self.walletRedirectNative = nil
                        self.walletRedirectUniversal = nil
                        completion(true)
                    }
                } catch {
                    completion(false)
                }
            }
        }
    }

    func dispatchEnvelope(_ url: URL) -> Bool {
        guard hasWalletConnectEnvelope(url) else { return false }
        do {
            try ensureConfigured()
            try Sign.instance.dispatchEnvelope(url.absoluteString)
            AgenticIOSLog.info("AgenticWalletConnect", "dispatchEnvelope", "DONE", "WalletConnect envelope dispatched", [
                "scheme": url.scheme ?? "",
                "host": url.host ?? "",
            ])
            return true
        } catch {
            AgenticIOSLog.fail("AgenticWalletConnect", "dispatchEnvelope", "FAIL", "WalletConnect envelope dispatch failed", [
                "message": error.localizedDescription,
            ])
            return false
        }
    }

    func clearState() {
        queue.sync {
            clearSessionStateLocked(reason: "manual_clear")
        }
    }

    // MARK: - Helpers

    private struct NormalizedSession {
        let pubkey: String
        let topic: String
        let chainId: String
        let redirectNative: String?
        let redirectUniversal: String?
    }

    private func normalizeSession(_ session: Session) -> NormalizedSession? {
        let preferredChainId = sessionChainId
        let solanaAccounts = session.namespaces["solana"]?.accounts
            ?? session.accounts.filter { $0.namespace == "solana" }
        let account = solanaAccounts.first(where: { $0.blockchainIdentifier == preferredChainId })
            ?? (preferredChainId == nil ? solanaAccounts.first : nil)
        guard let account, !account.address.isEmpty else { return nil }
        return NormalizedSession(
            pubkey: account.address,
            topic: session.topic,
            chainId: account.blockchainIdentifier,
            redirectNative: session.peer.redirect?.native,
            redirectUniversal: session.peer.redirect?.universal
        )
    }

    private func activateSession(_ session: NormalizedSession, source: String) {
        sessionPubkey = session.pubkey
        sessionTopic = session.topic
        sessionChainId = session.chainId
        walletRedirectNative = session.redirectNative
        walletRedirectUniversal = session.redirectUniversal
        AgenticIOSLog.info("AgenticWalletConnect", "activateSession", "DONE", "WalletConnect Solana session active", [
            "source": source,
            "chainId": session.chainId,
            "topic": short(session.topic),
            "pubkey": short(session.pubkey),
        ])
        let waiters = Array(sessionWaiters.values)
        sessionWaiters.removeAll()
        for waiter in waiters {
            waiter(.success((session.pubkey, session.topic)))
        }
    }

    private func clearSessionStateLocked(reason: String) {
        sessionPubkey = nil
        sessionTopic = nil
        sessionChainId = nil
        walletRedirectNative = nil
        walletRedirectUniversal = nil
        let waiters = Array(sessionWaiters.values)
        sessionWaiters.removeAll()
        for waiter in waiters {
            waiter(.failure(AgenticAgentError(code: "WC_NO_SESSION", message: "WalletConnect session cleared before approval completed.")))
        }
        AgenticIOSLog.info("AgenticWalletConnect", "clearSessionState", "DONE", "WalletConnect session state cleared", [
            "reason": reason,
        ])
    }

    private func activeTopic(for pubkey: String) -> Result<String, Error> {
        queue.sync {
            guard let topic = sessionTopic, let activePubkey = sessionPubkey, !activePubkey.isEmpty else {
                return .failure(AgenticAgentError(code: "WC_NO_SESSION", message: "No active WalletConnect session."))
            }
            guard activePubkey == pubkey else {
                return .failure(AgenticAgentError(code: "WC_PUBKEY_MISMATCH", message: "WalletConnect session belongs to a different account. Disconnect and reconnect Jupiter."))
            }
            return .success(topic)
        }
    }

    private func solanaChainId(for cluster: String) -> String {
        switch cluster.lowercased() {
        case "mainnet-beta", "mainnet": return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        case "devnet": return "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
        case "testnet": return "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"
        default: return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        }
    }

    private func hasWalletConnectEnvelope(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return false }
        let names = Set((components.queryItems ?? []).map(\.name))
        return names.contains("wc_ev") && names.contains("topic")
    }

    private func stringValue(_ value: Any, keys: [String]) -> String? {
        if let string = value as? String, !string.isEmpty {
            return string
        }
        if let anyCodable = value as? Commons.AnyCodable {
            return stringValue(anyCodable.value, keys: keys)
        }
        guard let dict = value as? [String: Any] else { return nil }
        for key in keys {
            if let string = dict[key] as? String, !string.isEmpty {
                return string
            }
            if let anyCodable = dict[key] as? Commons.AnyCodable,
               let string = stringValue(anyCodable.value, keys: keys) {
                return string
            }
        }
        return nil
    }

    private func short(_ value: String) -> String {
        if value.count <= 12 { return value }
        return "\(value.prefix(6))…\(value.suffix(4))"
    }

    private func sendRequest(topic: String, method: String, params: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        Task {
            do {
                let chain = self.queue.sync { self.sessionChainId } ?? solanaChainId(for: "mainnet-beta")
                let blockchain = Blockchain(chain) ?? Blockchain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")!
                let request = try Request(topic: topic, method: method, params: Commons.AnyCodable(any: params), chainId: blockchain)
                try await Sign.instance.request(params: request)
                self.launchCurrentWalletForRequest(method: method)
                // Subscribe to sessionResponsePublisher for the result.
                let result = try await waitForResponse(requestId: request.id)
                completion(.success(result))
            } catch {
                completion(.failure(error))
            }
        }
    }

    @MainActor
    private func waitForResponse(requestId: RPCID) async throws -> Any {
        return try await withCheckedThrowingContinuation { continuation in
            var cancellable: AnyCancellable?
            cancellable = Sign.instance.sessionResponsePublisher
                .filter { $0.id == requestId }
                .sink { response in
                    cancellable?.cancel()
                    switch response.result {
                    case .response(let value):
                        continuation.resume(returning: value.value)
                    case .error(let err):
                        continuation.resume(throwing: AgenticAgentError(code: "WC_RPC_\(err.code)", message: err.message))
                    }
                }
        }
    }

    private func launchCurrentWalletForRequest(method: String) {
        let redirect = queue.sync { walletRedirectNative ?? walletRedirectUniversal }
        guard let raw = redirect, let url = URL(string: raw) else {
            AgenticIOSLog.info("AgenticWalletConnect", "launchCurrentWalletForRequest", "SKIP", "no wallet redirect metadata", [
                "method": method,
            ])
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { launched in
                AgenticIOSLog.info("AgenticWalletConnect", "launchCurrentWalletForRequest", "DONE", "wallet launch attempted", [
                    "method": method,
                    "launched": String(launched),
                ])
            }
        }
    }
}

// MARK: - WebSocket factory glue

final class AgenticWalletConnectCryptoProvider: CryptoProvider {
    func recoverPubKey(signature: EthereumSignature, message: Data) throws -> Data {
        throw AgenticAgentError(code: "WC_UNSUPPORTED_CRYPTO", message: "Ethereum signature recovery is not supported by the Agentic Solana WalletConnect bridge.")
    }

    func keccak256(_ data: Data) -> Data {
        AgenticIOSLog.info("AgenticWalletConnect", "keccak256", "SKIP", "Ethereum keccak requested by Reown crypto provider; returning placeholder for unsupported EVM path")
        return Data(repeating: 0, count: 32)
    }
}

final class AgenticWebSocketFactory: WebSocketFactory {
    func create(with url: URL) -> WebSocketConnecting {
        AgenticWebSocket(url: url)
    }
}

final class AgenticWebSocket: NSObject, WebSocketConnecting, URLSessionWebSocketDelegate {
    var isConnected: Bool = false
    var onConnect: (() -> Void)?
    var onDisconnect: ((Error?) -> Void)?
    var onText: ((String) -> Void)?
    var request: URLRequest
    private var task: URLSessionWebSocketTask?
    private lazy var session: URLSession = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue())

    init(url: URL) {
        self.request = URLRequest(url: url)
    }

    func connect() {
        task = session.webSocketTask(with: request)
        task?.resume()
        receive()
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isConnected = false
    }

    func write(string: String, completion: (() -> Void)?) {
        task?.send(.string(string)) { _ in completion?() }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let msg):
                if case .string(let text) = msg { self.onText?(text) }
                self.receive()
            case .failure(let err):
                self.isConnected = false
                self.onDisconnect?(err)
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        isConnected = true
        onConnect?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        isConnected = false
        onDisconnect?(nil)
    }
}

#endif
