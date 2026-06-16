// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SolanaAgentWalletAdapterIosCapacitorBridge",
    // macOS is declared so `swift test` can plan a macOS-hosted build of the
    // Foundation-only enforcer tests (reown-swift needs macOS 11, the Solana
    // wallet adapter needs macOS 13). The shipped iOS plugin remains iOS-only;
    // CocoaPods consumes ios/Plugin/** as a single module via the podspec.
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(
            name: "SolanaAgentWalletAdapterIosCapacitorBridge",
            targets: ["SolanaAgentWalletAdapterIosCapacitorBridge"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.9.1"),
        .package(url: "https://github.com/reown-com/reown-swift.git", exact: "1.0.5"),
        // Native iOS Solana wallet adapter (IWA). Pinned to a commit because the
        // upstream repo has no release tags yet — swap to `exact: "0.1.0"` once a
        // tag is cut. Provides the Phantom/Solflare/Backpack encrypted-deeplink
        // signing used by AgenticNativeWalletPlugin (Jupiter stays on Reown above).
        .package(
            url: "https://github.com/mstevens843/ios-solana-wallet-adapter.git",
            revision: "16abab6abaae568f0ab1e3fb0a1381d645f0eb99"
        ),
    ],
    targets: [
        .target(
            name: "SolanaAgentWalletAdapterIosCapacitorBridge",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "Sodium", package: "swift-sodium"),
                .product(name: "Clibsodium", package: "swift-sodium"),
                .product(name: "WalletConnect", package: "reown-swift"),
                .product(name: "WalletConnectPairing", package: "reown-swift"),
                .product(name: "WalletConnectNetworking", package: "reown-swift"),
                // SolanaWalletAdapterUI transitively brings SolanaWalletAdapter,
                // SolanaWalletAdapterCore, and the Phantom/Solflare/Backpack provider
                // targets, plus WalletAdapterClient, UIKitWalletURLOpener,
                // KeychainWalletAdapterStateStore, and WalletProviderRegistry.
                .product(name: "SolanaWalletAdapterUI", package: "ios-solana-wallet-adapter"),
            ],
            path: "ios/Plugin"
        ),
        .testTarget(
            name: "SolanaAgentWalletAdapterIosCapacitorBridgeTests",
            dependencies: ["SolanaAgentWalletAdapterIosCapacitorBridge"],
            path: "Tests",
            resources: [
                .copy("Fixtures"),
            ]
        ),
    ]
)
