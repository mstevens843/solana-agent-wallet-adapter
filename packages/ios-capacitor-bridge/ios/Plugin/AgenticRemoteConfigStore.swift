// Swift port of apps/android-twa/.../config/RemoteConfigLoader.kt +
// RemoteConfigSchema.kt. Atomic snapshot, debounced refresh, disk cache via
// AgenticSecureStatePlugin's Keychain backing.
import Capacitor
import Foundation
import Security

// MARK: - Schema

struct AgenticMobileConfig: Codable, Equatable {
    let version: Int
    let walletRegistry: [AgenticWalletEntry]
    let memoProofRouter: AgenticMemoProofRouterConfig
    let featureFlags: [String: Bool]
    let walletConnectProjectId: String?
    let walletConnectPairingTimeoutMs: Int?
}

struct AgenticWalletEntry: Codable, Equatable {
    let id: String
    let name: String
    let deeplinkSchemes: [String]?
    let appStoreId: String?
    let supportsSignMessages: Bool
    let supportsSiws: Bool
    let forceWalletConnectFallback: Bool?
}

struct AgenticMemoProofRouterConfig: Codable, Equatable {
    let envelopeVersion: String
    let proofMemoPrefix: String
    let fallbackOnBlankPackage: Bool
}

enum AgenticRemoteConfigSource: String {
    case server
    case cache
    case bundled
}

struct AgenticRemoteConfigSnapshot {
    let config: AgenticMobileConfig
    let source: AgenticRemoteConfigSource
    let fetchedAtMs: Int64

    func toFullJson() -> [String: Any] {
        var dict = configToDictionary(config)
        dict["__meta"] = [
            "source": source.rawValue,
            "fetchedAtMs": fetchedAtMs,
        ]
        return dict
    }

    func statusJson() -> [String: Any] {
        [
            "version": config.version,
            "source": source.rawValue,
            "fetchedAtMs": fetchedAtMs,
            "walletCount": config.walletRegistry.count,
            "envelopeVersion": config.memoProofRouter.envelopeVersion,
        ]
    }
}

// MARK: - Defaults (must mirror Android RemoteConfigDefaults.kt EXACTLY)

enum AgenticRemoteConfigDefaults {
    static let memoEnvelopePrefix = "Agentic plan review proof v1\nSHA-256: "

    static let bundled = AgenticMobileConfig(
        version: 1,
        walletRegistry: [
            AgenticWalletEntry(
                id: "phantom",
                name: "Phantom",
                deeplinkSchemes: ["phantom", "https"],
                appStoreId: "1598432977",
                supportsSignMessages: true,
                supportsSiws: true,
                forceWalletConnectFallback: false
            ),
            AgenticWalletEntry(
                id: "solflare",
                name: "Solflare",
                deeplinkSchemes: ["solflare", "https"],
                appStoreId: "1580902717",
                supportsSignMessages: true,
                supportsSiws: false,
                forceWalletConnectFallback: false
            ),
            AgenticWalletEntry(
                id: "backpack",
                name: "Backpack",
                deeplinkSchemes: ["backpack", "https"],
                appStoreId: "6445964121",
                supportsSignMessages: true,
                supportsSiws: true,
                forceWalletConnectFallback: false
            ),
            AgenticWalletEntry(
                id: "jupiter",
                name: "Jupiter",
                deeplinkSchemes: ["wc"],
                appStoreId: "6484069059",
                supportsSignMessages: true,
                supportsSiws: false,
                forceWalletConnectFallback: true
            ),
        ],
        memoProofRouter: AgenticMemoProofRouterConfig(
            envelopeVersion: "v1",
            proofMemoPrefix: memoEnvelopePrefix,
            fallbackOnBlankPackage: true
        ),
        featureFlags: [:],
        walletConnectProjectId: nil,
        walletConnectPairingTimeoutMs: 120_000
    )
}

// MARK: - Store

final class AgenticRemoteConfigStore {
    static let shared = AgenticRemoteConfigStore()

    private let queue = DispatchQueue(label: "com.agentic.wallet.remoteconfig", qos: .utility)
    private let keychainService = "com.agentic.wallet.securestate"
    private let keychainKey = "remoteConfigV1"
    private var _snapshot: AgenticRemoteConfigSnapshot
    private var lastRefreshAtMs: Int64 = 0
    private var inFlight = false
    private var baseUrl: String = "https://agentic-signer.com"
    private let debounceMs: Int64 = 60_000

    private init() {
        _snapshot = AgenticRemoteConfigSnapshot(
            config: AgenticRemoteConfigDefaults.bundled,
            source: .bundled,
            fetchedAtMs: 0
        )
    }

    var snapshot: AgenticRemoteConfigSnapshot {
        queue.sync { _snapshot }
    }

    /// Bootstrap call from AppDelegate. Hydrates from disk cache if present.
    func initialize(baseUrl: String) {
        queue.sync {
            self.baseUrl = baseUrl
            if let cached = self.readCache() {
                self._snapshot = AgenticRemoteConfigSnapshot(
                    config: cached.config,
                    source: .cache,
                    fetchedAtMs: cached.fetchedAtMs
                )
                AgenticIOSLog.info("AgenticRemoteConfig", "initialize", "DONE", "hydrated from cache", [
                    "version": String(cached.config.version),
                    "walletCount": String(cached.config.walletRegistry.count),
                ])
            } else {
                AgenticIOSLog.info("AgenticRemoteConfig", "initialize", "DONE", "using bundled defaults")
            }
        }
    }

    /// Mirrors apps/android-twa/.../config/RemoteConfigLoader.kt:99-126. Debounced
    /// to debounceMs in-process unless force=true. Network IO on background queue.
    func refresh(force: Bool, completion: ((AgenticRemoteConfigSnapshot) -> Void)? = nil) {
        queue.async { [weak self] in
            guard let self else { return }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            if !force && now - self.lastRefreshAtMs < self.debounceMs {
                completion?(self._snapshot)
                return
            }
            if self.inFlight {
                completion?(self._snapshot)
                return
            }
            self.inFlight = true
            self.lastRefreshAtMs = now
            let url = self.baseUrl + "/api/mobile-config?platform=ios"
            self.fetch(url: url) { [weak self] result in
                guard let self else { return }
                self.queue.async {
                    self.inFlight = false
                    switch result {
                    case .success(let config):
                        let fetched = Int64(Date().timeIntervalSince1970 * 1000)
                        self._snapshot = AgenticRemoteConfigSnapshot(
                            config: config,
                            source: .server,
                            fetchedAtMs: fetched
                        )
                        self.writeCache(config: config, fetchedAtMs: fetched)
                        AgenticIOSLog.info("AgenticRemoteConfig", "refresh", "DONE", "server snapshot stored", [
                            "version": String(config.version),
                            "walletCount": String(config.walletRegistry.count),
                        ])
                    case .failure(let error):
                        AgenticIOSLog.fail("AgenticRemoteConfig", "refresh", "FAIL", "fetch failed", [
                            "error": error.localizedDescription,
                        ])
                    }
                    completion?(self._snapshot)
                }
            }
        }
    }

    /// Sync responder for `get` plugin method — returns the full config payload.
    func respondGet(_ call: CAPPluginCall) {
        call.resolve(snapshot.toFullJson())
    }

    // MARK: - Networking

    private func fetch(url: String, completion: @escaping (Result<AgenticMobileConfig, Error>) -> Void) {
        guard let endpoint = URL(string: url) else {
            completion(.failure(NSError(domain: "AgenticRemoteConfig", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid URL: \(url)"])))
            return
        }
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue("ios-bundled", forHTTPHeaderField: "x-agentic-client")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: request) { data, response, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                completion(.failure(NSError(domain: "AgenticRemoteConfig", code: code, userInfo: [NSLocalizedDescriptionKey: "HTTP \(code)"])))
                return
            }
            guard let data else {
                completion(.failure(NSError(domain: "AgenticRemoteConfig", code: -2, userInfo: [NSLocalizedDescriptionKey: "Empty body"])))
                return
            }
            do {
                let parsed = try AgenticRemoteConfigParser.parseV1(data)
                completion(.success(parsed))
            } catch {
                completion(.failure(error))
            }
        }
        task.resume()
    }

    // MARK: - Cache (Keychain)

    private struct CachedSnapshot: Codable {
        let config: AgenticMobileConfig
        let fetchedAtMs: Int64
    }

    private func readCache() -> CachedSnapshot? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(CachedSnapshot.self, from: data)
    }

    private func writeCache(config: AgenticMobileConfig, fetchedAtMs: Int64) {
        guard let data = try? JSONEncoder().encode(CachedSnapshot(config: config, fetchedAtMs: fetchedAtMs)) else { return }
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainKey,
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(addQuery as CFDictionary, nil)
    }
}

// MARK: - Parser (mirrors RemoteConfigSchema.kt:45-128)

enum AgenticRemoteConfigParser {
    /// Forward-compat parse: tolerate unknown fields, reject version < 1, fall back
    /// to bundled defaults for malformed sub-trees. Mirrors apps/android-twa/.../
    /// config/RemoteConfigSchema.kt:parse semantics.
    static func parseV1(_ data: Data) throws -> AgenticMobileConfig {
        let any = try JSONSerialization.jsonObject(with: data, options: [])
        guard let json = any as? [String: Any] else {
            throw NSError(domain: "AgenticRemoteConfig", code: -10, userInfo: [NSLocalizedDescriptionKey: "Top-level JSON is not an object"])
        }
        let version = (json["version"] as? Int) ?? 0
        guard version >= 1 else {
            throw NSError(domain: "AgenticRemoteConfig", code: -11, userInfo: [NSLocalizedDescriptionKey: "Version \(version) < floor 1"])
        }

        let wallets: [AgenticWalletEntry]
        if let raw = json["walletRegistry"] as? [[String: Any]] {
            wallets = raw.compactMap { parseWalletEntry($0) }
        } else if let nested = (json["walletRegistry"] as? [String: Any])?["ios"] as? [[String: Any]] {
            // Server might send per-platform structure: { walletRegistry: { ios: [...], android: [...] } }
            wallets = nested.compactMap { parseWalletEntry($0) }
        } else {
            wallets = AgenticRemoteConfigDefaults.bundled.walletRegistry
        }

        let router = (json["memoProofRouter"] as? [String: Any])
            .flatMap(parseMemoProofRouter) ?? AgenticRemoteConfigDefaults.bundled.memoProofRouter

        let flags = (json["featureFlags"] as? [String: Bool]) ?? [:]
        let projectId = json["walletConnectProjectId"] as? String
        let timeout = json["walletConnectPairingTimeoutMs"] as? Int

        return AgenticMobileConfig(
            version: version,
            walletRegistry: wallets,
            memoProofRouter: router,
            featureFlags: flags,
            walletConnectProjectId: projectId,
            walletConnectPairingTimeoutMs: timeout
        )
    }

    private static func parseWalletEntry(_ json: [String: Any]) -> AgenticWalletEntry? {
        guard let id = json["id"] as? String, let name = json["name"] as? String else { return nil }
        return AgenticWalletEntry(
            id: id,
            name: name,
            deeplinkSchemes: json["deeplinkSchemes"] as? [String],
            appStoreId: json["appStoreId"] as? String,
            supportsSignMessages: json["supportsSignMessages"] as? Bool ?? true,
            supportsSiws: json["supportsSiws"] as? Bool ?? false,
            forceWalletConnectFallback: json["forceWalletConnectFallback"] as? Bool
        )
    }

    private static func parseMemoProofRouter(_ json: [String: Any]) -> AgenticMemoProofRouterConfig {
        AgenticMemoProofRouterConfig(
            envelopeVersion: (json["envelopeVersion"] as? String) ?? "v1",
            proofMemoPrefix: (json["proofMemoPrefix"] as? String) ?? AgenticRemoteConfigDefaults.memoEnvelopePrefix,
            fallbackOnBlankPackage: (json["fallbackOnBlankPackage"] as? Bool) ?? true
        )
    }
}

// MARK: - Helpers

private func configToDictionary(_ config: AgenticMobileConfig) -> [String: Any] {
    let data = (try? JSONEncoder().encode(config)) ?? Data()
    let any = (try? JSONSerialization.jsonObject(with: data, options: [])) ?? [:]
    return (any as? [String: Any]) ?? [:]
}
