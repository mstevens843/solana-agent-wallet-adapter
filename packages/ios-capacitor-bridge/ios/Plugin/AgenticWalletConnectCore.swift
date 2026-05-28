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
// The Solana namespace methods we use:
//   - solana_signMessage
//   - solana_signTransaction
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

@available(iOS 16.0, *)
final class AgenticWalletConnectCore {
    static let shared = AgenticWalletConnectCore()

    private var cancellables = Set<AnyCancellable>()
    private var configured = false
    private let queue = DispatchQueue(label: "com.agentic.wallet.walletconnect", qos: .userInitiated)
    private let walletConnectGroupIdentifier = "group.com.agentic.wallet"
    private var sessionPubkey: String?
    private var sessionTopic: String?
    private var sessionWaiters: [(Result<(String, String), Error>) -> Void] = []

    private init() {}

    func ensureConfigured() throws {
        try queue.sync {
            if configured { return }
            let snapshot = AgenticRemoteConfigStore.shared.snapshot
            guard let projectId = snapshot.config.walletConnectProjectId, !projectId.isEmpty else {
                throw AgenticAgentError(code: "WC_NO_PROJECT_ID", message: "WalletConnect project id missing — set WALLETCONNECT_PROJECT_ID in cloud env.")
            }
            let redirect = try AppMetadata.Redirect(native: "agenticwallet://", universal: "https://agenticwalletadapter.com")
            let metadata = AppMetadata(
                name: "Agentic",
                description: "Agentic Wallet Adapter",
                url: "https://agentic-signer.com",
                icons: ["https://agentic-signer.com/icon.png"],
                redirect: redirect
            )
            Networking.configure(
                groupIdentifier: walletConnectGroupIdentifier,
                projectId: projectId,
                socketFactory: AgenticWebSocketFactory()
            )
            Pair.configure(metadata: metadata)
            // Subscribe to session lifecycle to surface to wcWaitForSession waiters.
            Sign.instance.sessionsPublisher
                .receive(on: queue)
                .sink { [weak self] sessions in
                    guard let self else { return }
                    guard let session = sessions.first else { return }
                    let pubkey = session.namespaces.values.first?.accounts.first?.address ?? ""
                    self.sessionPubkey = pubkey
                    self.sessionTopic = session.topic
                    let waiters = self.sessionWaiters
                    self.sessionWaiters.removeAll()
                    for waiter in waiters {
                        waiter(.success((pubkey, session.topic)))
                    }
                }
                .store(in: &cancellables)
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
        Task {
            do {
                let chain = solanaChainId(for: cluster)
                let methods: Set<String> = ["solana_signMessage", "solana_signTransaction", "solana_signAndSendTransaction"]
                let events: Set<String> = ["chainChanged", "accountsChanged"]
                let blockchain = Blockchain(chain) ?? Blockchain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")!
                let namespace = ProposalNamespace(chains: [blockchain], methods: methods, events: events)
                let uri = try await Sign.instance.connect(requiredNamespaces: ["solana": namespace])
                completion(.success((uri: uri.absoluteString, topic: uri.topic)))
            } catch {
                completion(.failure(error))
            }
        }
    }

    func waitForSession(timeoutMs: Int, completion: @escaping (Result<(pubkey: String, topic: String), Error>) -> Void) {
        do { try ensureConfigured() } catch { completion(.failure(error)); return }
        queue.async {
            if let pubkey = self.sessionPubkey, let topic = self.sessionTopic {
                completion(.success((pubkey, topic)))
                return
            }
            self.sessionWaiters.append { result in
                switch result {
                case .success(let pair): completion(.success((pubkey: pair.0, topic: pair.1)))
                case .failure(let err): completion(.failure(err))
                }
            }
            let timeout: DispatchTimeInterval = .milliseconds(timeoutMs)
            self.queue.asyncAfter(deadline: .now() + timeout) {
                if self.sessionPubkey != nil { return }
                completion(.failure(AgenticAgentError(code: "WC_TIMEOUT", message: "WalletConnect session timed out.")))
            }
        }
    }

    func currentSession() -> (pubkey: String, topic: String)? {
        queue.sync {
            guard let pubkey = sessionPubkey, let topic = sessionTopic else { return nil }
            return (pubkey, topic)
        }
    }

    func signMessage(pubkey: String, message: String, completion: @escaping (Result<String, Error>) -> Void) {
        do { try ensureConfigured() } catch { completion(.failure(error)); return }
        guard let topic = sessionTopic else {
            completion(.failure(AgenticAgentError(code: "WC_NO_SESSION", message: "No active WalletConnect session.")))
            return
        }
        let params: [String: Any] = ["pubkey": pubkey, "message": message]
        sendRequest(topic: topic, method: "solana_signMessage", params: params) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                guard let dict = data as? [String: Any],
                      let signature = dict["signature"] as? String else {
                    completion(.failure(AgenticAgentError(code: "WC_INVALID_RESPONSE", message: "Missing signature.")))
                    return
                }
                completion(.success(signature))
            }
        }
    }

    func signTransaction(pubkey: String, transaction: String, completion: @escaping (Result<(signature: String, transaction: String?), Error>) -> Void) {
        do { try ensureConfigured() } catch { completion(.failure(error)); return }
        guard let topic = sessionTopic else {
            completion(.failure(AgenticAgentError(code: "WC_NO_SESSION", message: "No active WalletConnect session.")))
            return
        }
        let params: [String: Any] = ["pubkey": pubkey, "transaction": transaction]
        sendRequest(topic: topic, method: "solana_signTransaction", params: params) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                guard let dict = data as? [String: Any],
                      let signature = dict["signature"] as? String else {
                    completion(.failure(AgenticAgentError(code: "WC_INVALID_RESPONSE", message: "Missing signature.")))
                    return
                }
                let tx = dict["transaction"] as? String
                completion(.success((signature: signature, transaction: tx)))
            }
        }
    }

    func signAndSendTransaction(pubkey: String, transaction: String, completion: @escaping (Result<(signature: String, txid: String?), Error>) -> Void) {
        do { try ensureConfigured() } catch { completion(.failure(error)); return }
        guard let topic = sessionTopic else {
            completion(.failure(AgenticAgentError(code: "WC_NO_SESSION", message: "No active WalletConnect session.")))
            return
        }
        let params: [String: Any] = ["pubkey": pubkey, "transaction": transaction]
        sendRequest(topic: topic, method: "solana_signAndSendTransaction", params: params) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let data):
                guard let dict = data as? [String: Any],
                      let signature = dict["signature"] as? String else {
                    completion(.failure(AgenticAgentError(code: "WC_INVALID_RESPONSE", message: "Missing signature.")))
                    return
                }
                let txid = dict["txid"] as? String ?? dict["signature"] as? String
                completion(.success((signature: signature, txid: txid)))
            }
        }
    }

    func disconnect(completion: @escaping (Bool) -> Void) {
        queue.async {
            guard let topic = self.sessionTopic else { completion(true); return }
            Task {
                do {
                    try await Sign.instance.disconnect(topic: topic)
                    self.queue.async {
                        self.sessionPubkey = nil
                        self.sessionTopic = nil
                        completion(true)
                    }
                } catch {
                    completion(false)
                }
            }
        }
    }

    func clearState() {
        queue.sync {
            sessionPubkey = nil
            sessionTopic = nil
            sessionWaiters.removeAll()
        }
    }

    // MARK: - Helpers

    private func solanaChainId(for cluster: String) -> String {
        switch cluster.lowercased() {
        case "mainnet-beta", "mainnet": return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        case "devnet": return "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
        case "testnet": return "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"
        default: return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        }
    }

    private func sendRequest(topic: String, method: String, params: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        Task {
            do {
                let blockchain = Blockchain(solanaChainId(for: "mainnet-beta")) ?? Blockchain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")!
                let request = try Request(topic: topic, method: method, params: Commons.AnyCodable(any: params), chainId: blockchain)
                try await Sign.instance.request(params: request)
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
}

// MARK: - WebSocket factory glue

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
