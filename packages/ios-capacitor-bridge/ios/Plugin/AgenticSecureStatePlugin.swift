import Capacitor
import Foundation
import Security

@objc(AgenticSecureStatePlugin)
public class AgenticSecureStatePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticSecureStatePlugin"
    public let jsName = "AgenticSecureState"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNamespace", returnType: CAPPluginReturnPromise),
    ]

    private let store = AgenticKeychainStore(service: "com.agentic.wallet.securestate")

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Missing key.", "INVALID_KEY")
            return
        }
        do {
            let value = try store.get(key: key)
            AgenticIOSLog.info("AgenticSecureState", "get", "DONE", "secure state read", ["key": key, "hit": String(value != nil)])
            call.resolve(["value": value ?? NSNull()])
        } catch {
            AgenticIOSLog.fail("AgenticSecureState", "get", "FAIL", "secure state read failed", ["key": key, "error": error.localizedDescription])
            call.reject(error.localizedDescription, "KEYCHAIN_ERROR")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Missing key.", "INVALID_KEY")
            return
        }
        guard let value = call.getString("value") else {
            call.reject("Missing value.", "INVALID_VALUE")
            return
        }
        do {
            try store.set(key: key, value: value)
            AgenticIOSLog.info("AgenticSecureState", "set", "DONE", "secure state written", ["key": key, "valueBytes": String(value.utf8.count)])
            call.resolve()
        } catch {
            AgenticIOSLog.fail("AgenticSecureState", "set", "FAIL", "secure state write failed", ["key": key, "error": error.localizedDescription])
            call.reject(error.localizedDescription, "KEYCHAIN_ERROR")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Missing key.", "INVALID_KEY")
            return
        }
        do {
            try store.remove(key: key)
            AgenticIOSLog.info("AgenticSecureState", "remove", "DONE", "secure state removed", ["key": key])
            call.resolve()
        } catch {
            AgenticIOSLog.fail("AgenticSecureState", "remove", "FAIL", "secure state remove failed", ["key": key, "error": error.localizedDescription])
            call.reject(error.localizedDescription, "KEYCHAIN_ERROR")
        }
    }

    @objc func clearNamespace(_ call: CAPPluginCall) {
        guard let prefix = call.getString("prefix"), !prefix.isEmpty else {
            call.reject("Missing prefix.", "INVALID_PREFIX")
            return
        }
        do {
            let count = try store.clear(prefix: prefix)
            AgenticIOSLog.info("AgenticSecureState", "clearNamespace", "DONE", "secure namespace cleared", ["prefix": prefix, "count": String(count)])
            call.resolve(["cleared": count])
        } catch {
            AgenticIOSLog.fail("AgenticSecureState", "clearNamespace", "FAIL", "secure namespace clear failed", ["prefix": prefix, "error": error.localizedDescription])
            call.reject(error.localizedDescription, "KEYCHAIN_ERROR")
        }
    }
}

private final class AgenticKeychainStore {
    private let service: String

    init(service: String) {
        self.service = service
    }

    func get(key: String) throws -> String? {
        var query = baseQuery(key: key)
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
        guard let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    func set(key: String, value: String) throws {
        let data = Data(value.utf8)
        let status = SecItemUpdate(baseQuery(key: key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess {
            return
        }
        if status != errSecItemNotFound {
            throw keychainError(status)
        }
        var query = baseQuery(key: key)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw keychainError(addStatus)
        }
    }

    func remove(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw keychainError(status)
        }
    }

    func clear(prefix: String) throws -> Int {
        var query = allKeysQuery()
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return 0
        }
        guard status == errSecSuccess else {
            throw keychainError(status)
        }
        let items = result as? [[String: Any]] ?? []
        var removed = 0
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String, account.hasPrefix(prefix) else {
                continue
            }
            try remove(key: account)
            removed += 1
        }
        return removed
    }

    private func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    private func allKeysQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
    }

    private func keychainError(_ status: OSStatus) -> NSError {
        NSError(
            domain: NSOSStatusErrorDomain,
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"]
        )
    }
}
