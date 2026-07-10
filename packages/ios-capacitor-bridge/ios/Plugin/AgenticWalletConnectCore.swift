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
    private var walletConnectRelayHost = "relay.walletconnect.com"
    private var walletConnectRelayOrigin = "https://agentic-signer.com"
    private var walletConnectRedirectNative = "agenticwallet://"
    private var walletConnectRedirectUniversal: String?
    private var walletConnectProjectIdPrefix = "unknown"
    private var latestSocketStatus = "unknown"
    private var sessionWaiters: [UUID: (Result<(String, String), Error>) -> Void] = [:]

    // Re-foreground state. Jupiter cold-starts unreliably: on a fresh boot it
    // sometimes drops our (spec-correct) `jupiter://wc?uri=…` deep link and shows
    // its web home (jup.ag) instead of the request. The proven recovery is to
    // re-fire the launch once the app is warm again. We retain just enough state
    // to re-fire exactly one automatic retry when the user returns to Agentic
    // without the connect/sign having completed (or unconditionally when the
    // manual "Open Jupiter again" button calls in with force:true).
    private var pendingPairingLaunchUrl: URL?
    private var pairingRetried = false
    private var pendingSignLaunch: (method: String, topic: String, requestId: RPCID)?
    private var signRetried = false
    private var lastWalletLaunchAt: Date?

    private init() {}

    func ensureConfigured() throws {
        try queue.sync {
            if configured { return }
            let snapshot = AgenticRemoteConfigStore.shared.snapshot
            guard let projectId = snapshot.config.walletConnectProjectId, !projectId.isEmpty else {
                AgenticIOSLog.fail("AgenticWalletConnect", "ensureConfigured", "NO_PROJECT_ID", "WalletConnect project id missing from /api/mobile-config — Jupiter cannot connect", [
                    "configSource": String(describing: snapshot.source),
                ])
                throw AgenticAgentError(code: "WC_NO_PROJECT_ID", message: "WalletConnect project id missing — set WALLETCONNECT_PROJECT_ID in cloud env.")
            }
            let relayHost = sanitizeRelayHost(snapshot.config.walletConnectRelayHost)
            let relayOrigin = sanitizeRelayOrigin(snapshot.config.walletConnectRelayOrigin)
            let redirectNative = sanitizeRedirectNative(snapshot.config.walletConnectRedirectNative)
            let redirectUniversal = sanitizeRedirectUniversal(snapshot.config.walletConnectRedirectUniversal)
            walletConnectRelayHost = relayHost
            walletConnectRelayOrigin = relayOrigin
            walletConnectRedirectNative = redirectNative
            walletConnectRedirectUniversal = redirectUniversal
            walletConnectProjectIdPrefix = String(projectId.prefix(8))
            // Pass the (sanitized) universal link alongside the custom scheme so
            // Jupiter can bounce the user back via Apple's associated-domain path
            // when iOS permits it. `sanitizeRedirectUniversal` guarantees nil or a
            // well-formed https URL; fall back to native-only if Redirect still
            // rejects it, so a bad value never breaks connect/sign entirely.
            let redirect: AppMetadata.Redirect
            do {
                redirect = try AppMetadata.Redirect(native: redirectNative, universal: redirectUniversal, linkMode: false)
            } catch {
                AgenticIOSLog.fail("AgenticWalletConnect", "ensureConfigured", "REDIRECT_FALLBACK", "universal redirect rejected; using native-only", [
                    "message": error.localizedDescription,
                ])
                redirect = try AppMetadata.Redirect(native: redirectNative, universal: nil, linkMode: false)
            }
            let metadata = AppMetadata(
                name: "Agentic",
                description: "Agentic Wallet Adapter",
                url: "https://agentic-signer.com",
                icons: ["https://agentic-signer.com/icons/agentic-512.png"],
                redirect: redirect
            )
            Networking.configure(
                relayHost: relayHost,
                groupIdentifier: walletConnectGroupIdentifier,
                projectId: projectId,
                socketFactory: AgenticWebSocketFactory(origin: relayOrigin)
            )
            Pair.configure(metadata: metadata)
            Sign.configure(crypto: AgenticWalletConnectCryptoProvider())
            AgenticIOSLog.info("AgenticWalletConnect", "ensureConfigured", "DONE", "WalletConnect configured", [
                "relayHost": relayHost,
                "originHost": originHost(relayOrigin),
                "redirectNative": urlShapeForLog(redirectNative),
                "redirectUniversal": redirectUniversal.map(urlShapeForLog) ?? "nil",
                "metadataRedirectUniversal": redirectUniversal.map(urlShapeForLog) ?? "nil",
                "projectIdPrefix": walletConnectProjectIdPrefix,
            ])
            Sign.instance.socketConnectionStatusPublisher
                .receive(on: queue)
                .sink { [weak self] status in
                    guard let self else { return }
                    switch status {
                    case .connected:
                        self.latestSocketStatus = "connected"
                    case .disconnected:
                        self.latestSocketStatus = "disconnected"
                    }
                    AgenticIOSLog.info("AgenticWalletConnect", "socketStatus", "DONE", "WalletConnect relay socket status changed", [
                        "status": self.latestSocketStatus,
                        "relayHost": self.walletConnectRelayHost,
                        "originHost": self.originHost(self.walletConnectRelayOrigin),
                    ])
                }
                .store(in: &cancellables)
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
            AgenticIOSLog.fail("AgenticWalletConnect", "connect", "CONFIG_FAILED", "WalletConnect not configured", [
                "message": error.localizedDescription,
            ])
            completion(.failure(error))
            return
        }
        let chain = solanaChainId(for: cluster)
        queue.async {
            self.sessionChainId = chain
        }
        AgenticIOSLog.info("AgenticWalletConnect", "connect", "START", "creating WalletConnect pairing", [
            "cluster": cluster,
            "chainId": chain,
        ])
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
                AgenticIOSLog.info("AgenticWalletConnect", "connect", "PAIRING_CREATED", "WalletConnect pairing URI created", [
                    "uriLen": String(uri.absoluteString.count),
                    "topic": self.short(uri.topic),
                ])
                completion(.success((uri: uri.absoluteString, topic: uri.topic)))
            } catch {
                completion(.failure(self.wrapWalletConnectError(error, operation: "wcConnect")))
            }
        }
    }

    func waitForSession(timeoutMs: Int, completion: @escaping (Result<(pubkey: String, topic: String), Error>) -> Void) {
        do { try ensureConfigured() } catch { completion(.failure(error)); return }
        queue.async {
            if let pubkey = self.sessionPubkey, !pubkey.isEmpty, let topic = self.sessionTopic {
                AgenticIOSLog.info("AgenticWalletConnect", "waitForSession", "ALREADY_ACTIVE", "session already settled", [
                    "pubkey": self.short(pubkey),
                    "topic": self.short(topic),
                ])
                completion(.success((pubkey, topic)))
                return
            }
            AgenticIOSLog.info("AgenticWalletConnect", "waitForSession", "WAITING", "waiting for session to settle over relay", [
                "timeoutMs": String(timeoutMs),
            ])
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
                    AgenticIOSLog.fail("AgenticWalletConnect", "waitForSession", "TIMEOUT", "session never settled over relay — wallet may not have approved or relay never delivered", [
                        "timeoutMs": String(timeoutMs),
                    ])
                    // The connect attempt is over; drop the retained pairing launch
                    // so a later didBecomeActive can't re-open Jupiter for a dead pairing.
                    self.pendingPairingLaunchUrl = nil
                    self.pairingRetried = false
                    waiter(.failure(AgenticAgentError(code: "WC_TIMEOUT", message: "WalletConnect session timed out.")))
                }
            }
        }
    }

    /// Remember the pairing deep link the plugin just opened so
    /// `reForegroundPendingWalletIfNeeded` can re-fire it once if Jupiter
    /// cold-dropped it. Resets the one-shot retry guard for this connect attempt.
    func setPendingPairingLaunch(url: URL) {
        queue.async {
            self.pendingPairingLaunchUrl = url
            self.pairingRetried = false
            self.lastWalletLaunchAt = Date()
            AgenticIOSLog.info("AgenticWalletConnect", "setPendingPairingLaunch", "DONE", "retained pairing launch URL for re-foreground", [
                "scheme": url.scheme ?? "none",
            ])
        }
    }

    /// Drop the retained in-flight sign request once its relay response arrives
    /// (or it fails), so a later return can't re-foreground Jupiter for a request
    /// that already resolved. Matches on requestId to avoid clearing a newer one.
    private func clearPendingSignLaunch(requestId: RPCID) {
        queue.async {
            if self.pendingSignLaunch?.requestId == requestId {
                self.pendingSignLaunch = nil
                self.signRetried = false
            }
        }
    }

    /// Called from `AgenticBridge.didBecomeActive()` (automatic, force=false) and
    /// from the manual "Open Jupiter again" button via the plugin (force=true).
    ///
    /// Jupiter cold-starts unreliably and sometimes drops our spec-correct
    /// `jupiter://wc?uri=…` deep link to its web home (jup.ag) instead of showing
    /// the request. When the user returns to Agentic with the connect/sign still
    /// pending, we re-fire the launch — Jupiter is warm by now, so it works (this
    /// automates the user's "try again 30s later" that already succeeds).
    ///
    /// A ~0.9s grace lets a settling relay message land first (so we don't re-open
    /// Jupiter right as the session/response arrives). The per-attempt `…Retried`
    /// guards cap the automatic path at exactly one retry; force=true bypasses them.
    func reForegroundPendingWalletIfNeeded(force: Bool = false) {
        guard (try? ensureConfigured()) != nil else { return }
        queue.asyncAfter(deadline: .now() + 0.9) {
            let elapsed = self.lastWalletLaunchAt.map { Date().timeIntervalSince($0) } ?? .greatestFiniteMagnitude
            // Don't fire during the initial open→background transition.
            guard force || elapsed >= 1.2 else {
                AgenticIOSLog.info("AgenticWalletConnect", "reForeground", "SKIP_TOO_SOON", "skipping re-foreground; launch too recent", [
                    "elapsedMs": String(Int(elapsed * 1000)),
                ])
                return
            }
            // Connect pending: waiters parked and no session settled yet.
            if self.sessionPubkey == nil, !self.sessionWaiters.isEmpty,
               let url = self.pendingPairingLaunchUrl, force || !self.pairingRetried {
                self.pairingRetried = true
                AgenticIOSLog.info("AgenticWalletConnect", "reForeground", "RETRY_CONNECT", "re-opening Jupiter to recover a dropped pairing launch", [
                    "scheme": url.scheme ?? "none",
                    "force": force ? "true" : "false",
                ])
                DispatchQueue.main.async {
                    UIApplication.shared.open(url, options: [:]) { launched in
                        AgenticIOSLog.info("AgenticWalletConnect", "reForeground", launched ? "RETRY_CONNECT_DONE" : "RETRY_CONNECT_REFUSED", "connect re-foreground attempt finished", [
                            "launched": launched ? "true" : "false",
                        ])
                    }
                }
                return
            }
            // Sign pending: a request is in flight (launched, no response yet).
            if let pending = self.pendingSignLaunch, force || !self.signRetried {
                self.signRetried = true
                AgenticIOSLog.info("AgenticWalletConnect", "reForeground", "RETRY_SIGN", "re-foregrounding Jupiter for an in-flight request", [
                    "method": pending.method,
                    "requestId": pending.requestId.string,
                    "force": force ? "true" : "false",
                ])
                // Dispatch OFF the serial queue: launchCurrentWalletForRequest does a
                // queue.sync internally, which would deadlock if run on the queue.
                DispatchQueue.main.async {
                    self.launchCurrentWalletForRequest(method: pending.method, topic: pending.topic, requestId: pending.requestId)
                }
                return
            }
            AgenticIOSLog.info("AgenticWalletConnect", "reForeground", "NOOP", "nothing pending to re-foreground", [
                "hasPendingPairing": self.pendingPairingLaunchUrl == nil ? "false" : "true",
                "hasPendingSign": self.pendingSignLaunch == nil ? "false" : "true",
                "sessionActive": self.sessionPubkey == nil ? "false" : "true",
            ])
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
                    AgenticIOSLog.fail("AgenticWalletConnect", "signMessage", "RESULT_MISSING_SIGNATURE", "wallet response had no signature field", [:])
                    completion(.failure(AgenticAgentError(code: "WC_INVALID_RESPONSE", message: "Missing signature.")))
                    return
                }
                AgenticIOSLog.info("AgenticWalletConnect", "signMessage", "RESULT", "message signed", [
                    "sigLen": String(signature.count),
                    "signature": signature,
                ])
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
                    AgenticIOSLog.fail("AgenticWalletConnect", "signTransaction", "RESULT_MISSING", "wallet response had neither signature nor transaction", [:])
                    completion(.failure(AgenticAgentError(code: "WC_INVALID_RESPONSE", message: "Missing signed transaction or signature.")))
                    return
                }
                AgenticIOSLog.info("AgenticWalletConnect", "signTransaction", "RESULT", "transaction signed", [
                    "hasSignature": signature != nil ? "true" : "false",
                    "hasTransaction": tx != nil ? "true" : "false",
                    "signature": signature ?? "",
                    "transaction": tx ?? "",
                ])
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
                    AgenticIOSLog.fail("AgenticWalletConnect", "signAndSendTransaction", "RESULT_MISSING_TXID", "wallet response had no txid/signature", [:])
                    completion(.failure(AgenticAgentError(code: "WC_INVALID_RESPONSE", message: "Missing transaction id.")))
                    return
                }
                AgenticIOSLog.info("AgenticWalletConnect", "signAndSendTransaction", "RESULT", "transaction sent by wallet", [
                    "txid": txid ?? "",
                    "sigLen": String(signature.count),
                ])
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
            guard let topic = self.sessionTopic else {
                AgenticIOSLog.info("AgenticWalletConnect", "disconnect", "NO_SESSION", "disconnect requested with no active session")
                completion(true)
                return
            }
            AgenticIOSLog.info("AgenticWalletConnect", "disconnect", "START", "disconnecting WalletConnect session", [
                "topic": self.short(topic),
            ])
            Task {
                do {
                    try await Sign.instance.disconnect(topic: topic)
                    self.queue.async {
                        self.sessionPubkey = nil
                        self.sessionTopic = nil
                        self.sessionChainId = nil
                        self.walletRedirectNative = nil
                        self.walletRedirectUniversal = nil
                        AgenticIOSLog.info("AgenticWalletConnect", "disconnect", "DONE", "WalletConnect session disconnected")
                        completion(true)
                    }
                } catch {
                    AgenticIOSLog.fail("AgenticWalletConnect", "disconnect", "FAIL", "WalletConnect disconnect failed", [
                        "message": error.localizedDescription,
                    ])
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
        // Connect succeeded — drop the retained pairing launch so a later return
        // can't re-open Jupiter for an already-settled pairing.
        pendingPairingLaunchUrl = nil
        pairingRetried = false
        AgenticIOSLog.info("AgenticWalletConnect", "activateSession", "DONE", "WalletConnect Solana session active", [
            "source": source,
            "chainId": session.chainId,
            "topic": short(session.topic),
            "pubkey": short(session.pubkey),
            "peerRedirectNative": session.redirectNative == nil ? "false" : "true",
            "peerRedirectUniversal": session.redirectUniversal == nil ? "false" : "true",
        ])
        let waiters = Array(sessionWaiters.values)
        sessionWaiters.removeAll()
        for waiter in waiters {
            waiter(.success((session.pubkey, session.topic)))
        }
        // A non-empty waiter list means a connect was in progress (vs. a silent
        // session restore on launch) — the user just approved pairing in Jupiter.
        // If we're backgrounded, post a tappable notification to bring them back,
        // mirroring the sign-request return notification.
        if !waiters.isEmpty {
            notifyWalletConnectConnected()
        }
    }

    private func notifyWalletConnectConnected() {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState != .active else {
                AgenticIOSLog.info("AgenticWalletConnect", "notifyReturn", "SKIP_FOREGROUND", "session settled while app active; no return notification needed")
                return
            }
            AgenticIOSLog.info("AgenticWalletConnect", "notifyReturn", "POST_CONNECT", "posting connect return notification (app backgrounded)")
            AgenticLocalNotification.postIfAuthorized(
                title: "Wallet connected",
                body: "Tap to return to Agentic.",
                tag: "\(AgenticLocalNotification.walletConnectPrefix)connect",
                userInfo: ["agenticWcResult": true, "kind": "connect"]
            )
        }
    }

    private func clearSessionStateLocked(reason: String) {
        sessionPubkey = nil
        sessionTopic = nil
        sessionChainId = nil
        walletRedirectNative = nil
        walletRedirectUniversal = nil
        pendingPairingLaunchUrl = nil
        pairingRetried = false
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
                AgenticIOSLog.fail("AgenticWalletConnect", "activeTopic", "NO_SESSION", "signing requested with no active session — connect Jupiter first", [
                    "requestedPubkey": short(pubkey),
                ])
                return .failure(AgenticAgentError(code: "WC_NO_SESSION", message: "No active WalletConnect session."))
            }
            guard activePubkey == pubkey else {
                AgenticIOSLog.fail("AgenticWalletConnect", "activeTopic", "PUBKEY_MISMATCH", "signing pubkey differs from the connected session", [
                    "requestedPubkey": short(pubkey),
                    "activePubkey": short(activePubkey),
                ])
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

    /// Build safe log fields for an outgoing request. Payload shapes (length,
    /// prefix) always log; the raw `transaction`/`message` values are included
    /// under their literal key names so AgenticIOSLog redacts them unless the
    /// opt-in raw mode is on.
    private func requestLogFields(method: String, topic: String, chainId: String, requestId: RPCID, params: [String: Any]) -> [String: String] {
        var fields: [String: String] = [
            "method": method,
            "requestId": requestId.string,
            "topic": short(topic),
            "chainId": chainId,
            "paramKeys": params.keys.sorted().joined(separator: ","),
        ]
        if let tx = params["transaction"] as? String {
            fields["txB64Len"] = String(tx.count)
            fields["txB64Prefix"] = String(tx.prefix(16))
            fields["transaction"] = tx
        }
        if let msg = params["message"] as? String {
            fields["msgLen"] = String(msg.count)
            // Key contains "payload" so AgenticIOSLog redacts it unless raw mode
            // is on ("message" alone is not redaction-eligible and is reused for
            // human-readable log text elsewhere).
            fields["messagePayload"] = msg
        }
        if let pubkey = params["pubkey"] as? String {
            fields["pubkey"] = short(pubkey)
        }
        return fields
    }

    private func responseShape(_ value: Any) -> String {
        if let anyCodable = value as? Commons.AnyCodable {
            return responseShape(anyCodable.value)
        }
        if let dict = value as? [String: Any] {
            return "keys=\(dict.keys.sorted().joined(separator: ","))"
        }
        if let string = value as? String {
            return "string(\(string.count))"
        }
        return String(describing: type(of: value))
    }

    private func sendRequest(topic: String, method: String, params: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        Task {
            var pendingRequestId: RPCID?
            do {
                let chain = self.queue.sync { self.sessionChainId } ?? solanaChainId(for: "mainnet-beta")
                let blockchain = Blockchain(chain) ?? Blockchain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")!
                let request = try Request(topic: topic, method: method, params: Commons.AnyCodable(any: params), chainId: blockchain)
                pendingRequestId = request.id
                AgenticIOSLog.info("AgenticWalletConnect", "sendRequest", "START", "sending WalletConnect request over relay", self.requestLogFields(method: method, topic: topic, chainId: chain, requestId: request.id, params: params))
                try await Sign.instance.request(params: request)
                AgenticIOSLog.info("AgenticWalletConnect", "sendRequest", "REQUEST_SENT", "request delivered to relay; foregrounding wallet", [
                    "method": method,
                    "requestId": request.id.string,
                ])
                // Retain the in-flight request so a return to Agentic (didBecomeActive
                // or the manual button) can re-foreground Jupiter if it dropped the
                // foreground trigger. Cleared once the relay response arrives below.
                let inFlightId = request.id
                self.queue.async {
                    self.pendingSignLaunch = (method: method, topic: topic, requestId: inFlightId)
                    self.signRetried = false
                    self.lastWalletLaunchAt = Date()
                }
                self.launchCurrentWalletForRequest(method: method, topic: topic, requestId: request.id)
                // Subscribe to sessionResponsePublisher for the result. This fires
                // over the relay regardless of app-switching, so the action
                // completes even when the user is still in Jupiter.
                let result = try await waitForResponse(requestId: request.id)
                self.clearPendingSignLaunch(requestId: request.id)
                self.notifyWalletConnectReturn(success: true, method: method, requestId: request.id)
                completion(.success(result))
            } catch {
                // If the request was dispatched (user likely sent to Jupiter), nudge
                // them back to see the failure/rejection. The notifier no-ops when
                // the app is already foregrounded, so a pre-dispatch relay error
                // (user never left) won't post.
                if let pendingRequestId {
                    self.clearPendingSignLaunch(requestId: pendingRequestId)
                    self.notifyWalletConnectReturn(success: false, method: method, requestId: pendingRequestId)
                }
                completion(.failure(error))
            }
        }
    }

    /// Post a tappable local notification when a WalletConnect response arrives
    /// and Agentic is backgrounded (the user is in Jupiter). On iOS 17+/18 Apple
    /// blocks silent app-to-app redirects, so this is the reliable way back.
    /// No-ops when the app is active — the in-app toast covers that.
    private func notifyWalletConnectReturn(success: Bool, method: String, requestId: RPCID) {
        DispatchQueue.main.async {
            let appState = UIApplication.shared.applicationState
            let appStateStr = appState == .active ? "active" : (appState == .inactive ? "inactive" : "background")
            guard appState != .active else {
                AgenticIOSLog.info("AgenticWalletConnect", "notifyReturn", "SKIP_FOREGROUND", "result arrived while app active; in-app toast will show it", [
                    "method": method,
                    "requestId": requestId.string,
                    "success": success ? "true" : "false",
                ])
                return
            }
            AgenticIOSLog.info("AgenticWalletConnect", "notifyReturn", "POST", "posting return notification (app backgrounded)", [
                "method": method,
                "requestId": requestId.string,
                "success": success ? "true" : "false",
                "appState": appStateStr,
            ])
            let title = success ? "Approval complete" : "Approval needs you"
            let body = success ? "Tap to return to Agentic." : "Open Agentic to see the result."
            AgenticLocalNotification.postIfAuthorized(
                title: title,
                body: body,
                tag: "\(AgenticLocalNotification.walletConnectPrefix)\(requestId.string)",
                userInfo: [
                    "agenticWcResult": success,
                    "requestId": requestId.string,
                    "method": method,
                ]
            )
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
                        AgenticIOSLog.info("AgenticWalletConnect", "waitForResponse", "RESPONSE", "wallet response received over relay", [
                            "requestId": requestId.string,
                            "result": self.responseShape(value.value),
                        ])
                        continuation.resume(returning: value.value)
                    case .error(let err):
                        AgenticIOSLog.fail("AgenticWalletConnect", "waitForResponse", "ERROR", "wallet returned an RPC error", [
                            "requestId": requestId.string,
                            "wcErrorCode": String(err.code),
                            "wcErrorMessage": err.message,
                        ])
                        continuation.resume(throwing: AgenticAgentError(code: "WC_RPC_\(err.code)", message: err.message))
                    }
                }
        }
    }

    private func launchCurrentWalletForRequest(method: String, topic: String, requestId: RPCID) {
        // The request is already on the relay; foreground the wallet so its
        // pending-request sheet appears. Opening *another* app is allowed on iOS
        // — only returning to ourselves is the restricted case the notification
        // handles.
        //
        // A WC sign request is NOT carried in a deep link — it rides the relay to
        // the paired wallet, so there is nothing to encode. We foreground Jupiter via
        // its bare custom scheme `jupiter://` (see
        // AgenticWalletConnectDeepLink.jupiterRequestForegroundUrl) and let its WC
        // client surface the pending request. A warm/installed Jupiter opens the app
        // — jup.ag is only the UNIVERSAL-link cold-start fallthrough, not the custom
        // scheme. We deliberately do NOT synthesize a pairing URI: reown-swift rejects
        // a topic-only `wc:<topic>@2` with "The format of the WalletConnect Pairing
        // URI is invalid." (the exact error users hit on cloud sign-in).
        //
        // Do NOT use the session peer redirect when Jupiter advertises the Reown
        // sample wallet's walletapp:// / https://lab.reown.com (that sent users to
        // Safari). If iOS refuses the launch we log FAIL and the in-app "Open Jupiter
        // again" button (force re-foreground) is the recovery.
        let redirects: (native: String?, universal: String?) = queue.sync {
            (walletRedirectNative, walletRedirectUniversal)
        }
        var raws: [String] = []
        if let foregroundUrl = AgenticWalletConnectDeepLink.jupiterRequestForegroundUrl(sessionTopic: topic)?.absoluteString {
            raws.append(foregroundUrl)
        }
        let urls = raws.compactMap { URL(string: $0) }
        guard !urls.isEmpty else {
            AgenticIOSLog.fail("AgenticWalletConnect", "launchCurrentWalletForRequest", "NO_URL", "no wallet launch URL available — cannot foreground Jupiter", [
                "method": method,
                "requestId": requestId.string,
                "topic": short(topic),
            ])
            return
        }
        AgenticIOSLog.info("AgenticWalletConnect", "launchCurrentWalletForRequest", "START", "foregrounding wallet for request", [
            "method": method,
            "requestId": requestId.string,
            "topic": short(topic),
            "candidateCount": String(urls.count),
            "candidates": urls.map { "\($0.scheme ?? "?")://\($0.host ?? "")" }.joined(separator: ","),
            "peerRedirectNative": redirects.native == nil ? "false" : "true",
            "peerRedirectUniversal": redirects.universal == nil ? "false" : "true",
        ])
        openWalletCandidate(urls, index: 0, method: method, requestId: requestId)
    }

    private func openWalletCandidate(_ urls: [URL], index: Int, method: String, requestId: RPCID) {
        guard index < urls.count else {
            AgenticIOSLog.fail("AgenticWalletConnect", "launchCurrentWalletForRequest", "FAIL", "iOS refused every candidate — Jupiter not installed or scheme not openable", [
                "method": method,
                "requestId": requestId.string,
            ])
            return
        }
        let url = urls[index]
        // For http(s) candidates, require a real universal-link owner: with
        // universalLinksOnly, open() returns false (and we try the next candidate)
        // instead of silently falling back to Safari. Custom schemes use [:].
        let scheme = url.scheme?.lowercased()
        let options: [UIApplication.OpenExternalURLOptionsKey: Any] =
            (scheme == "http" || scheme == "https") ? [.universalLinksOnly: true] : [:]
        DispatchQueue.main.async {
            AgenticIOSLog.info("AgenticWalletConnect", "launchCurrentWalletForRequest", "ATTEMPT", "trying to open wallet", [
                "scheme": url.scheme ?? "",
                "host": url.host ?? "",
                "index": String(index),
                "requestId": requestId.string,
            ])
            UIApplication.shared.open(url, options: options) { launched in
                if launched {
                    AgenticIOSLog.info("AgenticWalletConnect", "launchCurrentWalletForRequest", "DONE", "wallet foregrounded", [
                        "scheme": url.scheme ?? "",
                        "host": url.host ?? "",
                        "method": method,
                        "requestId": requestId.string,
                    ])
                } else {
                    AgenticIOSLog.fail("AgenticWalletConnect", "launchCurrentWalletForRequest", "CANDIDATE_REFUSED", "iOS refused candidate; trying next", [
                        "scheme": url.scheme ?? "",
                        "index": String(index),
                        "requestId": requestId.string,
                    ])
                    self.openWalletCandidate(urls, index: index + 1, method: method, requestId: requestId)
                }
            }
        }
    }

    private func sanitizeRelayHost(_ raw: String?) -> String {
        let fallback = "relay.walletconnect.com"
        guard let raw else { return fallback }
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return fallback }
        if value.lowercased().hasPrefix("wss://") || value.lowercased().hasPrefix("ws://") {
            value = URL(string: value)?.host ?? value
        }
        value = value.split(separator: "/").first.map(String.init) ?? value
        guard value.range(of: #"^[A-Za-z0-9.-]+$"#, options: .regularExpression) != nil else {
            return fallback
        }
        return value.lowercased()
    }

    private func sanitizeRelayOrigin(_ raw: String?) -> String {
        let fallback = "https://agentic-signer.com"
        guard let raw else { return fallback }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value),
              url.scheme?.lowercased() == "https",
              let host = url.host,
              !host.isEmpty else {
            return fallback
        }
        return "https://\(host.lowercased())"
    }

    private func sanitizeRedirectNative(_ raw: String?) -> String {
        let fallback = "agenticwallet://"
        guard let raw else { return fallback }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              !scheme.isEmpty,
              scheme != "http",
              scheme != "https" else {
            return fallback
        }
        if scheme == "agenticwallet" {
            return fallback
        }
        return value
    }

    private func sanitizeRedirectUniversal(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value),
              url.scheme?.lowercased() == "https",
              let host = url.host,
              !host.isEmpty else {
            return nil
        }
        return value
    }

    private func originHost(_ origin: String) -> String {
        URL(string: origin)?.host ?? "unknown"
    }

    private func urlShapeForLog(_ value: String) -> String {
        guard let url = URL(string: value) else { return "invalid" }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        let queryKeys = (components?.queryItems ?? []).map(\.name).sorted().joined(separator: ",")
        return [
            "scheme=\(url.scheme ?? "")",
            "host=\(url.host ?? "")",
            "path=\(url.path)",
            "query_keys=\(queryKeys)",
        ].joined(separator: " ")
    }

    private func wrapWalletConnectError(_ error: Error, operation: String) -> Error {
        let message = [
            error.localizedDescription,
            "operation=\(operation)",
            "relayHost=\(walletConnectRelayHost)",
            "originHost=\(originHost(walletConnectRelayOrigin))",
            "projectIdPrefix=\(walletConnectProjectIdPrefix)",
            "socketStatus=\(latestSocketStatus)",
        ].joined(separator: " | ")
        AgenticIOSLog.fail("AgenticWalletConnect", operation, "FAIL", "WalletConnect relay operation failed", [
            "relayHost": walletConnectRelayHost,
            "originHost": originHost(walletConnectRelayOrigin),
            "projectIdPrefix": walletConnectProjectIdPrefix,
            "socketStatus": latestSocketStatus,
            "message": error.localizedDescription,
        ])
        return AgenticAgentError(code: "WC_RELAY_FAILED", message: message)
    }
}

// MARK: - WebSocket factory glue

final class AgenticWalletConnectCryptoProvider: CryptoProvider {
    func recoverPubKey(signature: EthereumSignature, message: Data) throws -> Data {
        throw AgenticAgentError(code: "WC_UNSUPPORTED_CRYPTO", message: "Ethereum signature recovery is not supported by the Agentic Solana WalletConnect bridge.")
    }

    func keccak256(_ data: Data) -> Data {
        AgenticKeccak256.hash(data)
    }
}

final class AgenticWebSocketFactory: WebSocketFactory {
    private let origin: String

    init(origin: String) {
        self.origin = origin
    }

    func create(with url: URL) -> WebSocketConnecting {
        AgenticWebSocket(url: url, origin: origin)
    }
}

final class AgenticWebSocket: NSObject, WebSocketConnecting, URLSessionWebSocketDelegate {
    var isConnected: Bool = false
    var onConnect: (() -> Void)?
    var onDisconnect: ((Error?) -> Void)?
    var onText: ((String) -> Void)?
    var request: URLRequest {
        get { rawRequest }
        set {
            rawRequest = newValue
            rawRequest.setValue(origin, forHTTPHeaderField: "Origin")
        }
    }
    private var rawRequest: URLRequest
    private let origin: String
    private var task: URLSessionWebSocketTask?
    private lazy var session: URLSession = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue())

    init(url: URL, origin: String) {
        self.origin = origin
        var request = URLRequest(url: url)
        request.setValue(origin, forHTTPHeaderField: "Origin")
        self.rawRequest = request
    }

    func connect() {
        if isConnected { return }
        if task != nil {
            task?.cancel(with: .goingAway, reason: nil)
            task = nil
        }
        AgenticIOSLog.info("AgenticWalletConnect", "webSocketConnect", "START", "opening WalletConnect relay socket", [
            "host": request.url?.host ?? "",
            "originHost": URL(string: origin)?.host ?? "unknown",
        ])
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
        guard let task else {
            let error = AgenticAgentError(code: "WC_SOCKET_NOT_OPEN", message: "WalletConnect relay socket task is not open.")
            AgenticIOSLog.fail("AgenticWalletConnect", "webSocketWrite", "FAIL", "WalletConnect relay socket write skipped", [
                "message": error.localizedDescription,
            ])
            onDisconnect?(error)
            completion?()
            return
        }
        task.send(.string(string)) { [weak self] error in
            if let error {
                self?.isConnected = false
                AgenticIOSLog.fail("AgenticWalletConnect", "webSocketWrite", "FAIL", "WalletConnect relay socket write failed", [
                    "message": error.localizedDescription,
                ])
                self?.onDisconnect?(error)
            }
            completion?()
        }
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
                AgenticIOSLog.fail("AgenticWalletConnect", "webSocketReceive", "FAIL", "WalletConnect relay socket receive failed", [
                    "message": err.localizedDescription,
                ])
                self.onDisconnect?(err)
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        isConnected = true
        AgenticIOSLog.info("AgenticWalletConnect", "webSocketConnect", "DONE", "WalletConnect relay socket opened", [
            "host": request.url?.host ?? "",
        ])
        onConnect?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        isConnected = false
        let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        AgenticIOSLog.info("AgenticWalletConnect", "webSocketClose", "DONE", "WalletConnect relay socket closed", [
            "code": String(closeCode.rawValue),
            "reason": reasonText,
        ])
        onDisconnect?(nil)
    }
}

#endif
