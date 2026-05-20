import Foundation
import Security
import TweetNacl

final class AgenticDeepLinkService {
    private let appURL = "https://agenticwalletadapter.com/app"
    private let callbackScheme = "agenticwallet"

    func makeConnectRequest(walletID: AgenticWalletID, cluster: AgenticCluster) throws -> (request: AgenticPendingRequest, url: URL) {
        let descriptor = walletID.descriptor
        guard descriptor.transport == .encryptedDeeplink, let baseURL = descriptor.baseURL else {
            throw AgenticWalletError.unsupportedWallet(walletID.rawValue)
        }
        let keyPair = try NaclBox.keyPair()
        let requestID = UUID().uuidString.lowercased()
        let redirect = try callbackURL(phase: .connect, requestID: requestID)
        var components = URLComponents(url: baseURL.appendingPathComponent("connect"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "app_url", value: appURL),
            URLQueryItem(name: "dapp_encryption_public_key", value: Base58.encode(keyPair.publicKey)),
            URLQueryItem(name: "redirect_link", value: redirect.absoluteString),
            URLQueryItem(name: "cluster", value: cluster.rawValue),
        ]
        guard let url = components?.url else {
            throw AgenticWalletError.invalidCallback("Unable to build wallet connect URL.")
        }
        let request = AgenticPendingRequest(
            id: requestID,
            phase: .connect,
            walletID: walletID,
            cluster: cluster,
            createdAt: Date(),
            dappPublicKey: keyPair.publicKey,
            dappSecretKey: keyPair.secretKey
        )
        AgenticIOSNativeLog.info("AgenticDeepLinkService", "makeConnectRequest", "URL_BUILT", "wallet connect URL built", [
            "wallet": walletID.rawValue,
            "requestId": requestID,
            "urlShape": urlShape(url),
        ])
        return (request, url)
    }

    func completeConnect(callbackURL: URL, pending: AgenticPendingRequest) throws -> AgenticAuthRecord {
        try throwIfWalletError(callbackURL)
        let descriptor = pending.walletID.descriptor
        let params = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let paramMap = Dictionary(uniqueKeysWithValues: params.map { ($0.name, $0.value ?? "") })

        guard let walletEncryptionKeyBase58 = descriptor.walletEncryptionKeyParams.compactMap({ paramMap[$0] }).first,
              !walletEncryptionKeyBase58.isEmpty else {
            throw AgenticWalletError.invalidCallback("iOS connect callback is missing wallet encryption public key.")
        }
        guard let nonceBase58 = paramMap["nonce"], let dataBase58 = paramMap["data"] else {
            throw AgenticWalletError.invalidCallback("iOS connect callback is missing encrypted payload.")
        }

        let walletEncryptionPublicKey = try Base58.decode(walletEncryptionKeyBase58)
        let nonce = try Base58.decode(nonceBase58)
        let encrypted = try Base58.decode(dataBase58)
        let sharedSecret = try NaclBox.before(publicKey: walletEncryptionPublicKey, secretKey: pending.dappSecretKey)
        let plaintext = try NaclSecretBox.open(box: encrypted, nonce: nonce, key: sharedSecret)
        let payload = try JSONDecoder().decode(ConnectPayload.self, from: plaintext)

        let record = AgenticAuthRecord(
            publicKey: payload.publicKey,
            walletID: pending.walletID,
            walletName: descriptor.name,
            cluster: pending.cluster,
            sessionBase58: payload.session,
            walletEncryptionPublicKeyBase58: walletEncryptionKeyBase58,
            sharedSecretBase64: sharedSecret.base64EncodedString(),
            dappPublicKeyBase64: pending.dappPublicKey.base64EncodedString(),
            dappSecretKeyBase64: pending.dappSecretKey.base64EncodedString(),
            walletConnectTopic: nil,
            timestampUnixSeconds: nowSeconds(),
            authenticated: true
        )
        AgenticIOSNativeLog.info("AgenticDeepLinkService", "completeConnect", "SUCCESS", "wallet callback decrypted", [
            "wallet": pending.walletID.rawValue,
            "pubkey": short(payload.publicKey),
            "requestId": pending.id,
        ])
        return record
    }

    func makeSignMessageRequest(message: Data, record: AgenticAuthRecord) throws -> (request: AgenticPendingRequest, url: URL) {
        try makeSigningRequest(method: "signMessage", payload: [
            "session": try require(record.sessionBase58, "Cached session is missing."),
            "message": Base58.encode(message),
        ], record: record)
    }

    func makeSignTransactionRequest(transaction: Data, record: AgenticAuthRecord) throws -> (request: AgenticPendingRequest, url: URL) {
        try makeSigningRequest(method: "signTransaction", payload: [
            "session": try require(record.sessionBase58, "Cached session is missing."),
            "transaction": Base58.encode(transaction),
        ], record: record)
    }

    func completeSigning(callbackURL: URL, record: AgenticAuthRecord) throws -> AgenticSigningResult {
        try throwIfWalletError(callbackURL)
        guard let sharedSecretBase64 = record.sharedSecretBase64, let sharedSecret = Data(base64Encoded: sharedSecretBase64) else {
            throw AgenticWalletError.incompleteAuthorization
        }
        let params = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let paramMap = Dictionary(uniqueKeysWithValues: params.map { ($0.name, $0.value ?? "") })
        guard let nonceBase58 = paramMap["nonce"], let dataBase58 = paramMap["data"] else {
            throw AgenticWalletError.invalidCallback("iOS signing callback is missing encrypted payload.")
        }
        let nonce = try Base58.decode(nonceBase58)
        let encrypted = try Base58.decode(dataBase58)
        let plaintext = try NaclSecretBox.open(box: encrypted, nonce: nonce, key: sharedSecret)
        let payload = try JSONDecoder().decode(SigningPayload.self, from: plaintext)
        guard let signature = payload.signature ?? payload.transaction else {
            throw AgenticWalletError.invalidCallback("Wallet signing response is missing signature or transaction.")
        }
        AgenticIOSNativeLog.info("AgenticDeepLinkService", "completeSigning", "SUCCESS", "wallet signing callback decrypted", [
            "wallet": record.walletID.rawValue,
            "pubkey": short(record.publicKey),
            "resultKeys": payload.transaction == nil ? "signature" : "signature,transaction",
        ])
        return AgenticSigningResult(signatureBase58: signature, transactionBase58: payload.transaction)
    }

    private func makeSigningRequest(
        method: String,
        payload: [String: String],
        record: AgenticAuthRecord
    ) throws -> (request: AgenticPendingRequest, url: URL) {
        let descriptor = record.walletID.descriptor
        guard descriptor.transport == .encryptedDeeplink, let baseURL = descriptor.baseURL else {
            throw AgenticWalletError.unsupportedWallet(record.walletID.rawValue)
        }
        guard let sharedSecretBase64 = record.sharedSecretBase64,
              let sharedSecret = Data(base64Encoded: sharedSecretBase64),
              let dappPublicKeyBase64 = record.dappPublicKeyBase64,
              let dappPublicKey = Data(base64Encoded: dappPublicKeyBase64),
              let dappSecretKeyBase64 = record.dappSecretKeyBase64,
              let dappSecretKey = Data(base64Encoded: dappSecretKeyBase64) else {
            throw AgenticWalletError.incompleteAuthorization
        }
        let requestID = UUID().uuidString.lowercased()
        let redirect = try callbackURL(phase: .sign, requestID: requestID)
        let nonce = try randomBytes(count: 24)
        let payloadData = try JSONEncoder().encode(payload)
        let encrypted = try NaclSecretBox.secretBox(message: payloadData, nonce: nonce, key: sharedSecret)
        var components = URLComponents(url: baseURL.appendingPathComponent(method), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "dapp_encryption_public_key", value: Base58.encode(dappPublicKey)),
            URLQueryItem(name: "nonce", value: Base58.encode(nonce)),
            URLQueryItem(name: "redirect_link", value: redirect.absoluteString),
            URLQueryItem(name: "payload", value: Base58.encode(encrypted)),
        ]
        guard let url = components?.url else {
            throw AgenticWalletError.invalidCallback("Unable to build wallet signing URL.")
        }
        let request = AgenticPendingRequest(
            id: requestID,
            phase: .sign,
            walletID: record.walletID,
            cluster: record.cluster,
            createdAt: Date(),
            dappPublicKey: dappPublicKey,
            dappSecretKey: dappSecretKey
        )
        AgenticIOSNativeLog.info("AgenticDeepLinkService", "makeSigningRequest", "URL_BUILT", "wallet signing URL built", [
            "wallet": record.walletID.rawValue,
            "method": method,
            "requestId": requestID,
            "payloadKeys": payload.keys.sorted().joined(separator: ","),
            "urlShape": urlShape(url),
        ])
        return (request, url)
    }

    private func callbackURL(phase: AgenticPendingPhase, requestID: String) throws -> URL {
        var components = URLComponents()
        components.scheme = callbackScheme
        components.host = "callback"
        components.path = "/\(phase.rawValue)"
        components.queryItems = [
            URLQueryItem(name: "requestId", value: requestID),
            URLQueryItem(name: "phase", value: phase.rawValue),
        ]
        // `URLComponents.url` returns optional. Today the inputs are static
        // (callbackScheme + literal host/path) + a generated requestID, so
        // building the URL should always succeed — but force-unwrap on a
        // public API surface would produce an opaque crash if any input ever
        // changes shape (a future phase enum value containing a slash, etc.).
        // Surface a typed error instead so callers can decide how to recover.
        guard let url = components.url else {
            throw AgenticWalletError.invalidCallback(
                "Unable to construct iOS callback URL for phase \(phase.rawValue)."
            )
        }
        return url
    }

    private func throwIfWalletError(_ url: URL) throws {
        let params = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let paramMap = Dictionary(uniqueKeysWithValues: params.map { ($0.name, $0.value ?? "") })
        if let code = paramMap["errorCode"] ?? paramMap["errorCode".lowercased()] {
            let message = paramMap["errorMessage"] ?? "Wallet rejected the request."
            throw AgenticWalletError.walletRejected("\(code): \(message)")
        }
    }

    private func require(_ value: String?, _ message: String) throws -> String {
        guard let value, !value.isEmpty else {
            throw AgenticWalletError.invalidCallback(message)
        }
        return value
    }

    private func randomBytes(count: Int) throws -> Data {
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw AgenticWalletError.cryptoFailed("Unable to generate secure random bytes.")
        }
        return data
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

    private func urlShape(_ url: URL) -> String {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let keys = components?.queryItems?.map(\.name).sorted().joined(separator: ",") ?? ""
        return "scheme=\(url.scheme ?? "") host=\(url.host ?? "") path=\(url.path) query_keys=\(keys)"
    }
}

private struct ConnectPayload: Decodable {
    let publicKey: String
    let session: String

    enum CodingKeys: String, CodingKey {
        case publicKey = "public_key"
        case session
    }
}

private struct SigningPayload: Decodable {
    let signature: String?
    let transaction: String?
}
