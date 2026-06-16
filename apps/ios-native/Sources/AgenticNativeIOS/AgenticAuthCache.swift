import Foundation
import Security

final class AgenticAuthCache {
    private let key = "agentic-ios-auth-cache-v1"
    private let service = "com.agentic.wallet.native.authcache"

    func summary() -> (count: Int, latest: AgenticAuthRecord?) {
        let root = readRoot()
        let latest = root.latest.flatMap { root.records[$0] }
        return (root.records.count, latest)
    }

    func latest(walletID: AgenticWalletID? = nil) -> AgenticAuthRecord? {
        let root = readRoot()
        if let walletID {
            return root.records.values
                .filter { $0.walletID == walletID && isUsable($0) }
                .sorted { $0.timestampUnixSeconds > $1.timestampUnixSeconds }
                .first
        }
        if let latestKey = root.latest, let record = root.records[latestKey], isUsable(record) {
            return record
        }
        return root.records.values
            .filter(isUsable)
            .sorted { $0.timestampUnixSeconds > $1.timestampUnixSeconds }
            .first
    }

    func set(_ record: AgenticAuthRecord) {
        var root = readRoot()
        let merged = Self.mergedRecord(record, existing: root.records[record.publicKey])
        root.records[record.publicKey] = merged
        root.latest = record.publicKey
        writeRoot(root)
        AgenticIOSNativeLog.info("AgenticAuthCache", "set", "DONE", "authorization cached", [
            "wallet": merged.walletID.rawValue,
            "pubkey": short(merged.publicKey),
            "authenticated": String(merged.authenticated),
        ])
    }

    static func mergedRecord(_ incoming: AgenticAuthRecord, existing: AgenticAuthRecord?) -> AgenticAuthRecord {
        guard let existing,
              existing.publicKey == incoming.publicKey,
              existing.walletID == incoming.walletID else {
            return incoming
        }
        var merged = incoming
        merged.sessionBase58 = nonBlank(incoming.sessionBase58, existing.sessionBase58)
        merged.walletEncryptionPublicKeyBase58 = nonBlank(
            incoming.walletEncryptionPublicKeyBase58,
            existing.walletEncryptionPublicKeyBase58
        )
        merged.sharedSecretBase64 = nonBlank(incoming.sharedSecretBase64, existing.sharedSecretBase64)
        merged.dappPublicKeyBase64 = nonBlank(incoming.dappPublicKeyBase64, existing.dappPublicKeyBase64)
        merged.dappSecretKeyBase64 = nonBlank(incoming.dappSecretKeyBase64, existing.dappSecretKeyBase64)
        merged.walletConnectTopic = nonBlank(incoming.walletConnectTopic, existing.walletConnectTopic)
        return merged
    }

    private static func nonBlank(_ incoming: String?, _ cached: String?) -> String? {
        if let incoming, !incoming.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return incoming
        }
        return cached ?? incoming
    }

    func clear(publicKey: String) {
        var root = readRoot()
        root.records.removeValue(forKey: publicKey)
        if root.latest == publicKey {
            root.latest = root.records.values.sorted { $0.timestampUnixSeconds > $1.timestampUnixSeconds }.first?.publicKey
        }
        writeRoot(root)
        AgenticIOSNativeLog.info("AgenticAuthCache", "clear", "DONE", "authorization cleared", ["pubkey": short(publicKey)])
    }

    func clearAll() {
        writeRoot(AgenticAuthCacheRoot())
        AgenticIOSNativeLog.info("AgenticAuthCache", "clearAll", "DONE", "all authorizations cleared")
    }

    private func readRoot() -> AgenticAuthCacheRoot {
        do {
            guard let data = keychainReadWithDebugUserDefaultsFallback() else {
                return AgenticAuthCacheRoot()
            }
            return try JSONDecoder().decode(AgenticAuthCacheRoot.self, from: data)
        } catch {
            AgenticIOSNativeLog.fail("AgenticAuthCache", "readRoot", "FAIL", "cache read failed", ["error": error.localizedDescription])
            return AgenticAuthCacheRoot()
        }
    }

    private func keychainReadWithDebugUserDefaultsFallback() -> Data? {
        do {
            return try keychainRead() ?? debugUserDefaultsRead()
        } catch {
            return debugUserDefaultsRead()
        }
    }

    private func writeRoot(_ root: AgenticAuthCacheRoot) {
        do {
            let data = try JSONEncoder().encode(root)
            do {
                try keychainWrite(data)
            } catch {
                #if DEBUG
                userDefaultsWrite(data)
                #else
                throw error
                #endif
            }
        } catch {
            AgenticIOSNativeLog.fail("AgenticAuthCache", "writeRoot", "FAIL", "cache write failed", ["error": error.localizedDescription])
        }
    }

    private func isUsable(_ record: AgenticAuthRecord) -> Bool {
        if record.walletID == .jupiter {
            return !record.publicKey.isEmpty
        }
        return !record.publicKey.isEmpty
            && record.sessionBase58 != nil
            && record.sharedSecretBase64 != nil
            && record.dappPublicKeyBase64 != nil
    }

    private func keychainRead() throws -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw keychainError(status)
        }
        return item as? Data
    }

    private func keychainWrite(_ data: Data) throws {
        let status = SecItemUpdate(baseQuery() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess {
            return
        }
        if status != errSecItemNotFound {
            throw keychainError(status)
        }
        var query = baseQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw keychainError(addStatus)
        }
    }

    private func userDefaultsRead() -> Data? {
        UserDefaults.standard.data(forKey: key)
    }

    private func debugUserDefaultsRead() -> Data? {
        #if DEBUG
        return userDefaultsRead()
        #else
        return nil
        #endif
    }

    private func userDefaultsWrite(_ data: Data) {
        UserDefaults.standard.set(data, forKey: key)
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    private func keychainError(_ status: OSStatus) -> NSError {
        NSError(
            domain: NSOSStatusErrorDomain,
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"]
        )
    }

    private func short(_ value: String, prefix: Int = 8, suffix: Int = 8) -> String {
        if value.count <= prefix + suffix {
            return value
        }
        return "\(value.prefix(prefix))...\(value.suffix(suffix))"
    }
}
