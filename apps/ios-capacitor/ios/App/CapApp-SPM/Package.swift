// swift-tools-version: 5.9
import PackageDescription

// MOSTLY managed by Capacitor CLI commands.
// NOTE: platforms .iOS(.v16) is enforced by apps/ios-capacitor/scripts/ensure-ios.mjs
// after every `cap sync` because the bridge package requires iOS 16+.
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.3.1"),
        .package(name: "CapacitorApp", path: "../../../../../node_modules/.pnpm/@capacitor+app@8.1.0_@capacitor+core@8.3.1/node_modules/@capacitor/app"),
        .package(name: "SolanaAgentWalletAdapterIosCapacitorBridge", path: "../../../../../packages/ios-capacitor-bridge")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "SolanaAgentWalletAdapterIosCapacitorBridge", package: "SolanaAgentWalletAdapterIosCapacitorBridge")
            ]
        )
    ]
)
