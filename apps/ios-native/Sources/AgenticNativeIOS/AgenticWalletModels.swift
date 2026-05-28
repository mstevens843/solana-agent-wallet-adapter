import Foundation

enum AgenticCluster: String, CaseIterable, Identifiable, Codable {
    case mainnetBeta = "mainnet-beta"
    case devnet
    case testnet
    case localnet

    var id: String { rawValue }

    var rpcURL: URL {
        switch self {
        case .mainnetBeta:
            URL(string: "https://api.mainnet-beta.solana.com")!
        case .devnet:
            URL(string: "https://api.devnet.solana.com")!
        case .testnet:
            URL(string: "https://api.testnet.solana.com")!
        case .localnet:
            URL(string: "http://127.0.0.1:8899")!
        }
    }

    var walletConnectChainID: String {
        switch self {
        case .mainnetBeta:
            "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        case .devnet, .localnet:
            "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
        case .testnet:
            "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"
        }
    }
}

enum AgenticWalletTransport: String, Codable {
    case encryptedDeeplink
    case walletConnect
}

enum AgenticWalletID: String, CaseIterable, Identifiable, Codable {
    case phantom
    case solflare
    case backpack
    case jupiter

    var id: String { rawValue }

    var descriptor: AgenticWalletDescriptor {
        switch self {
        case .phantom:
            AgenticWalletDescriptor(
                id: self,
                name: "Phantom",
                baseURL: URL(string: "https://phantom.app/ul/v1")!,
                walletEncryptionKeyParams: ["phantom_encryption_public_key", "wallet_encryption_public_key"],
                transport: .encryptedDeeplink,
                appStoreURL: URL(string: "https://apps.apple.com/app/phantom-crypto-wallet/id1598432977")!
            )
        case .solflare:
            AgenticWalletDescriptor(
                id: self,
                name: "Solflare",
                baseURL: URL(string: "https://solflare.com/ul/v1")!,
                walletEncryptionKeyParams: ["solflare_encryption_public_key", "wallet_encryption_public_key"],
                transport: .encryptedDeeplink,
                appStoreURL: URL(string: "https://apps.apple.com/app/solflare-solana-wallet/id1580902717")!
            )
        case .backpack:
            AgenticWalletDescriptor(
                id: self,
                name: "Backpack",
                baseURL: URL(string: "https://backpack.app/ul/v1")!,
                walletEncryptionKeyParams: ["backpack_encryption_public_key", "wallet_encryption_public_key"],
                transport: .encryptedDeeplink,
                appStoreURL: URL(string: "https://apps.apple.com/app/backpack-crypto-wallet/id6445964121")!
            )
        case .jupiter:
            AgenticWalletDescriptor(
                id: self,
                name: "Jupiter",
                baseURL: nil,
                walletEncryptionKeyParams: [],
                transport: .walletConnect,
                appStoreURL: URL(string: "https://apps.apple.com/app/jupiter-exchange-solana/id6484069059")!
            )
        }
    }
}

struct AgenticWalletDescriptor: Identifiable {
    let id: AgenticWalletID
    let name: String
    let baseURL: URL?
    let walletEncryptionKeyParams: [String]
    let transport: AgenticWalletTransport
    let appStoreURL: URL
}

struct AgenticAuthRecord: Codable, Identifiable, Equatable {
    let publicKey: String
    let walletID: AgenticWalletID
    let walletName: String
    var cluster: AgenticCluster
    var sessionBase58: String?
    var walletEncryptionPublicKeyBase58: String?
    var sharedSecretBase64: String?
    var dappPublicKeyBase64: String?
    var dappSecretKeyBase64: String?
    var walletConnectTopic: String?
    var timestampUnixSeconds: Int
    var authenticated: Bool

    var id: String { publicKey }
}

struct AgenticAuthCacheRoot: Codable {
    var schema = 1
    var latest: String?
    var records: [String: AgenticAuthRecord] = [:]
}

enum AgenticPendingPhase: String {
    case connect
    case sign
}

struct AgenticPendingRequest: Identifiable {
    let id: String
    let phase: AgenticPendingPhase
    let walletID: AgenticWalletID
    let cluster: AgenticCluster
    let createdAt: Date
    let dappPublicKey: Data
    let dappSecretKey: Data
}

struct AgenticSigningResult: Equatable {
    let signatureBase58: String
    let transactionBase58: String?
}

struct AgenticWalletBalanceSummary: Equatable {
    let totalText: String
    let solText: String
    let usdcText: String
    let statusText: String
}

enum AgenticWalletError: LocalizedError {
    case unsupportedWallet(String)
    case invalidCallback(String)
    case walletRejected(String)
    case missingCachedAuthorization
    case incompleteAuthorization
    case cryptoFailed(String)
    case walletConnectNotConfigured

    var errorDescription: String? {
        switch self {
        case .unsupportedWallet(let wallet):
            "Unsupported wallet: \(wallet)"
        case .invalidCallback(let message):
            message
        case .walletRejected(let message):
            message
        case .missingCachedAuthorization:
            "No cached iOS authorization is available."
        case .incompleteAuthorization:
            "Cached iOS authorization is incomplete. Connect again."
        case .cryptoFailed(let message):
            message
        case .walletConnectNotConfigured:
            "Jupiter requires the Reown WalletConnect SDK bridge in the native Swift target."
        }
    }
}
