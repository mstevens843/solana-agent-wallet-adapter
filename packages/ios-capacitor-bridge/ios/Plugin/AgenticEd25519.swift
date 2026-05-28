import Foundation
import Sodium

enum AgenticEd25519 {
    static let seedBytes = 32
    static let publicKeyBytes = 32
    static let secretKeyBytes = 64
    static let signatureBytes = 64

    static func publicKey(seed: Data) throws -> Data {
        return try keyPair(seed: seed).publicKey
    }

    static func sign(seed: Data, message: Data) throws -> Data {
        let pair = try keyPair(seed: seed)
        let sodium = Sodium()
        guard let signature = sodium.sign.signature(message: Array(message), secretKey: pair.secretKey) else {
            throw error("Could not sign Ed25519 message.")
        }
        guard signature.count == signatureBytes else {
            throw error("Invalid Ed25519 signature length.")
        }
        return Data(signature)
    }

    private static func keyPair(seed: Data) throws -> (publicKey: Data, secretKey: [UInt8]) {
        guard seed.count == seedBytes else {
            throw error("Ed25519 seed must be \(seedBytes) bytes.")
        }
        let sodium = Sodium()
        guard let pair = sodium.sign.keyPair(seed: Array(seed)) else {
            throw error("Could not derive Ed25519 keypair from seed.")
        }
        guard pair.publicKey.count == publicKeyBytes, pair.secretKey.count == secretKeyBytes else {
            throw error("Invalid Ed25519 keypair length.")
        }
        return (Data(pair.publicKey), pair.secretKey)
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "AgenticEd25519", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
