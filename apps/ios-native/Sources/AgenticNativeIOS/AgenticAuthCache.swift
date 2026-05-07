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
        root.records[record.publicKey] = record
        root.latest = record.publicKey
        writeRoot(root)
        AgenticIOSNativeLog.info("AgenticAuthCache", "set", "DONE", "authorization cached", [
            "wallet": record.walletID.rawValue,
            "pubkey": short(record.publicKey),
            "authenticated": String(record.authenticated),
        ])
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
            guard let data = try keychainRead() ?? userDefaultsRead() else {
                return AgenticAuthCacheRoot()
            }
            return try JSONDecoder().decode(AgenticAuthCacheRoot.self, from: data)
        } catch {
            AgenticIOSNativeLog.fail("AgenticAuthCache", "readRoot", "FAIL", "cache read failed", ["error": error.localizedDescription])
            return AgenticAuthCacheRoot()
        }
    }

    private func writeRoot(_ root: AgenticAuthCacheRoot) {
        do {
            let data = try JSONEncoder().encode(root)
            do {
                try keychainWrite(data)
            } catch {
                userDefaultsWrite(data)
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
