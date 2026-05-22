// Swift port of apps/android-twa/.../streaming/StreamingSessionController.kt.
// Ed25519 ephemeral signers backed by CryptoKit (Apple-native, hardware-backed
// via Secure Enclave when available). Seeds stored in Keychain with
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly.
//
// Vouchers are canonical-JSON serialized (AgenticCanonicalJSON), SHA-256 hashed,
// and signed with the session's Ed25519 key. The byte-for-byte hash + signature
// must match Android (Phase 7 fixture test enforces this).
import CryptoKit
import Foundation
import Security

final class AgenticStreamingSessionController {
    static let shared = AgenticStreamingSessionController()

    private let queue = DispatchQueue(label: "com.agentic.wallet.streaming", qos: .userInitiated)
    private let service = "com.agentic.wallet.streaming.v1"
    private let signerKeyPrefix = "signer."
    private let sessionKeyPrefix = "session."

    private init() {}

    // MARK: Public surface (called from AgenticStreamingSessionPlugin)

    func prepareSessionSigner(metadata: [String: Any]?) -> [String: Any] {
        return queue.sync {
            let key = Curve25519.Signing.PrivateKey()
            let signerId = "signer_" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
            let pubBase58 = AgenticBase58.encode(key.publicKey.rawRepresentation)
            do {
                try persistSigner(signerId: signerId, seed: key.rawRepresentation, metadata: metadata ?? [:])
                AgenticIOSLog.info("AgenticStreaming", "prepareSessionSigner", "DONE", "signer ready", [
                    "signerId": signerId,
                ])
                return [
                    "signerId": signerId,
                    "ephemeralSignerPubkey": pubBase58,
                    "signerRuntime": "ios-native",
                    "activeSessions": activeSessionCount(),
                ]
            } catch {
                AgenticIOSLog.fail("AgenticStreaming", "prepareSessionSigner", "FAIL", "persist failed", [
                    "error": error.localizedDescription,
                ])
                return [
                    "ok": false,
                    "error": error.localizedDescription,
                    "code": "KEYCHAIN_ERROR",
                ]
            }
        }
    }

    func createSession(sessionId: String, ephemeralPrivkeyBase64: String, metadata: [String: Any]?) -> [String: Any] {
        return queue.sync {
            guard let seedData = Data(base64Encoded: ephemeralPrivkeyBase64), seedData.count == 32 else {
                return errorResponse(code: "INVALID_PRIVKEY", message: "Ephemeral private key must be 32 bytes (base64).")
            }
            do {
                let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seedData)
                let pubBase58 = AgenticBase58.encode(key.publicKey.rawRepresentation)
                try persistSession(sessionId: sessionId, seed: seedData, pubkeyBase58: pubBase58, metadata: metadata ?? [:])
                AgenticIOSLog.info("AgenticStreaming", "createSession", "DONE", "session created", ["sessionId": sessionId])
                return [
                    "sessionId": sessionId,
                    "ephemeralSignerPubkey": pubBase58,
                    "signerRuntime": "ios-native",
                    "activeSessions": activeSessionCount(),
                ]
            } catch {
                return errorResponse(code: "CRYPTO_ERROR", message: error.localizedDescription)
            }
        }
    }

    func bindPreparedSession(sessionId: String, signerId: String, metadata: [String: Any]?) -> [String: Any] {
        return queue.sync {
            do {
                guard let signer = try readSigner(signerId: signerId) else {
                    return errorResponse(code: "SIGNER_NOT_FOUND", message: "Unknown signerId: \(signerId)")
                }
                let pubBase58 = AgenticBase58.encode(signer.publicKey.rawRepresentation)
                try persistSession(sessionId: sessionId, seed: signer.rawRepresentation, pubkeyBase58: pubBase58, metadata: metadata ?? [:])
                try deleteSigner(signerId: signerId)
                AgenticIOSLog.info("AgenticStreaming", "bindPreparedSession", "DONE", "bound", [
                    "sessionId": sessionId,
                    "signerId": signerId,
                ])
                return [
                    "sessionId": sessionId,
                    "ephemeralSignerPubkey": pubBase58,
                    "signerRuntime": "ios-native",
                    "activeSessions": activeSessionCount(),
                ]
            } catch {
                return errorResponse(code: "KEYCHAIN_ERROR", message: error.localizedDescription)
            }
        }
    }

    func activateSession(sessionId: String, metadata: [String: Any]?) -> [String: Any] {
        return queue.sync {
            do {
                guard var record = try readSessionRecord(sessionId: sessionId) else {
                    return errorResponse(code: "SESSION_NOT_FOUND", message: "Unknown sessionId: \(sessionId)")
                }
                if let metadata {
                    for (k, v) in metadata {
                        record.metadata[k] = v
                    }
                }
                record.metadata["status"] = "active"
                try writeSessionRecord(sessionId: sessionId, record: record)
                return [
                    "sessionId": sessionId,
                    "activeSessions": activeSessionCount(),
                    "status": "active",
                ]
            } catch {
                return errorResponse(code: "KEYCHAIN_ERROR", message: error.localizedDescription)
            }
        }
    }

    func signVoucher(sessionId: String, voucherJson: String) -> [String: Any] {
        let started = Date()
        return queue.sync {
            do {
                guard let record = try readSessionRecord(sessionId: sessionId) else {
                    return errorResponse(code: "SESSION_NOT_FOUND", message: "Unknown sessionId: \(sessionId)")
                }
                guard let data = voucherJson.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data, options: []) else {
                    return errorResponse(code: "INVALID_VOUCHER", message: "Voucher is not valid JSON.")
                }
                let canonical = try AgenticCanonicalJSON.encode(parsed)
                let digest = SHA256.hash(data: canonical)
                let key = try Curve25519.Signing.PrivateKey(rawRepresentation: record.seed)
                let sigData = try key.signature(for: Data(digest))
                let latencyMs = Int(Date().timeIntervalSince(started) * 1000)
                return [
                    "sessionId": sessionId,
                    "signature": AgenticBase58.encode(sigData),
                    "signatureEncoding": "ed25519",
                    "voucherHash": digest.map { String(format: "%02x", $0) }.joined(),
                    "cached": false,
                    "latencyMs": latencyMs,
                    "activeSessions": activeSessionCount(),
                ]
            } catch {
                return errorResponse(code: "CRYPTO_ERROR", message: error.localizedDescription)
            }
        }
    }

    func signSettlementTx(sessionId: String, settlement: [String: Any]) -> [String: Any] {
        return queue.sync {
            do {
                guard let record = try readSessionRecord(sessionId: sessionId) else {
                    return errorResponse(code: "SESSION_NOT_FOUND", message: "Unknown sessionId: \(sessionId)")
                }
                guard let txBase64 = settlement["transactionBase64"] as? String,
                      let txBytes = Data(base64Encoded: txBase64) else {
                    return errorResponse(code: "INVALID_TX", message: "Missing transactionBase64.")
                }
                // Solana txs: signatures live in the prefix; the message body
                // starts at offset (1 + 64 * numSigs). Decoder-free: use the
                // signature count byte and sign everything after.
                guard let firstByte = txBytes.first else {
                    return errorResponse(code: "INVALID_TX", message: "Empty transaction.")
                }
                let numSigs = Int(firstByte)
                let messageOffset = 1 + 64 * numSigs
                guard messageOffset < txBytes.count else {
                    return errorResponse(code: "INVALID_TX", message: "Truncated transaction.")
                }
                let messageData = txBytes.subdata(in: messageOffset..<txBytes.count)
                let key = try Curve25519.Signing.PrivateKey(rawRepresentation: record.seed)
                let signature = try key.signature(for: messageData)
                // Replace the first signature slot (the session signer is by
                // convention the first/only signer in a streaming settlement).
                var signed = txBytes
                let sigBytes = [UInt8](signature)
                for (i, byte) in sigBytes.enumerated() {
                    signed[1 + i] = byte
                }
                return [
                    "sessionId": sessionId,
                    "signedTransactionBase64": signed.base64EncodedString(),
                    "signature": AgenticBase58.encode(signature),
                    "latencyMs": 0,
                    "changed": true,
                ]
            } catch {
                return errorResponse(code: "CRYPTO_ERROR", message: error.localizedDescription)
            }
        }
    }

    func revokeLocalSession(sessionId: String) -> [String: Any] {
        return queue.sync {
            do {
                try deleteSession(sessionId: sessionId)
                return [
                    "sessionId": sessionId,
                    "revoked": true,
                    "activeSessions": activeSessionCount(),
                ]
            } catch {
                return errorResponse(code: "KEYCHAIN_ERROR", message: error.localizedDescription)
            }
        }
    }

    func statusJson() -> [String: Any] {
        let count = queue.sync { activeSessionCount() }
        return [
            "available": true,
            "runtime": "ios-native",
            "signerRuntime": "ios-native",
            "activeSessions": count,
            "remainingDisplay": "",
            "message": "Ready (\(count) active)",
            "capabilities": [
                "prepareSessionSigner",
                "createSession",
                "bindPreparedSession",
                "activateSession",
                "signVoucher",
                "signSettlementTx",
                "revokeLocalSession",
            ],
        ]
    }

    func notificationState() -> [String: Any] {
        let count = queue.sync { activeSessionCount() }
        return [
            "activeCount": count,
            "remainingDisplay": "",
            "text": count > 0 ? "\(count) streaming session(s)" : "",
        ]
    }

    // MARK: - Internal records

    private struct SignerRecord: Codable {
        let signerId: String
        let seed: Data
        let metadata: [String: AnyCodable]
    }

    private struct SessionRecord: Codable {
        let sessionId: String
        let seed: Data
        let pubkeyBase58: String
        var metadata: [String: Any] {
            get { metadataStorage.mapValues { $0.value } }
            set { metadataStorage = newValue.mapValues { AnyCodable($0) } }
        }
        private var metadataStorage: [String: AnyCodable]
        init(sessionId: String, seed: Data, pubkeyBase58: String, metadata: [String: Any]) {
            self.sessionId = sessionId
            self.seed = seed
            self.pubkeyBase58 = pubkeyBase58
            self.metadataStorage = metadata.mapValues { AnyCodable($0) }
        }
    }

    private func persistSigner(signerId: String, seed: Data, metadata: [String: Any]) throws {
        let record = SignerRecord(signerId: signerId, seed: seed, metadata: metadata.mapValues { AnyCodable($0) })
        let data = try JSONEncoder().encode(record)
        try keychainWrite(account: signerKeyPrefix + signerId, data: data)
    }

    private func readSigner(signerId: String) throws -> Curve25519.Signing.PrivateKey? {
        guard let data = try keychainRead(account: signerKeyPrefix + signerId) else { return nil }
        let record = try JSONDecoder().decode(SignerRecord.self, from: data)
        return try Curve25519.Signing.PrivateKey(rawRepresentation: record.seed)
    }

    private func deleteSigner(signerId: String) throws {
        try keychainDelete(account: signerKeyPrefix + signerId)
    }

    private func persistSession(sessionId: String, seed: Data, pubkeyBase58: String, metadata: [String: Any]) throws {
        let record = SessionRecord(sessionId: sessionId, seed: seed, pubkeyBase58: pubkeyBase58, metadata: metadata)
        let data = try JSONEncoder().encode(record)
        try keychainWrite(account: sessionKeyPrefix + sessionId, data: data)
    }

    private func readSessionRecord(sessionId: String) throws -> SessionRecord? {
        guard let data = try keychainRead(account: sessionKeyPrefix + sessionId) else { return nil }
        return try JSONDecoder().decode(SessionRecord.self, from: data)
    }

    private func writeSessionRecord(sessionId: String, record: SessionRecord) throws {
        let data = try JSONEncoder().encode(record)
        try keychainWrite(account: sessionKeyPrefix + sessionId, data: data)
    }

    private func deleteSession(sessionId: String) throws {
        try keychainDelete(account: sessionKeyPrefix + sessionId)
    }

    private func activeSessionCount() -> Int {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { return 0 }
        return items.filter { ($0[kSecAttrAccount as String] as? String)?.hasPrefix(sessionKeyPrefix) == true }.count
    }

    private func keychainWrite(account: String, data: Data) throws {
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let update = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        if update != errSecItemNotFound { throw keychainError(update) }
        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let add = SecItemAdd(addQuery as CFDictionary, nil)
        if add != errSecSuccess { throw keychainError(add) }
    }

    private func keychainRead(account: String) throws -> Data? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw keychainError(status) }
        return item as? Data
    }

    private func keychainDelete(account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound { throw keychainError(status) }
    }

    private func keychainError(_ status: OSStatus) -> NSError {
        NSError(
            domain: NSOSStatusErrorDomain,
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"]
        )
    }

    private func errorResponse(code: String, message: String) -> [String: Any] {
        return [
            "ok": false,
            "code": code,
            "message": message,
        ]
    }
}

// MARK: - AnyCodable helper for arbitrary JSON metadata

struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { value = NSNull(); return }
        if let b = try? container.decode(Bool.self) { value = b; return }
        if let i = try? container.decode(Int64.self) { value = i; return }
        if let d = try? container.decode(Double.self) { value = d; return }
        if let s = try? container.decode(String.self) { value = s; return }
        if let arr = try? container.decode([AnyCodable].self) { value = arr.map { $0.value }; return }
        if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
            return
        }
        value = NSNull()
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull: try container.encodeNil()
        case let b as Bool: try container.encode(b)
        case let i as Int: try container.encode(Int64(i))
        case let i as Int64: try container.encode(i)
        case let d as Double: try container.encode(d)
        case let s as String: try container.encode(s)
        case let arr as [Any]: try container.encode(arr.map { AnyCodable($0) })
        case let dict as [String: Any]: try container.encode(dict.mapValues { AnyCodable($0) })
        default: try container.encodeNil()
        }
    }
}
