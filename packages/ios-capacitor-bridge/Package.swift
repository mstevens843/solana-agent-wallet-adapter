// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SolanaAgentWalletAdapterIosCapacitorBridge",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "SolanaAgentWalletAdapterIosCapacitorBridge",
            targets: ["SolanaAgentWalletAdapterIosCapacitorBridge"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.9.1"),
    ],
    targets: [
        .target(
            name: "SolanaAgentWalletAdapterIosCapacitorBridge",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Sodium", package: "swift-sodium"),
                .product(name: "Clibsodium", package: "swift-sodium"),
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
