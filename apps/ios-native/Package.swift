// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AgenticNativeIOS",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .executable(name: "AgenticNativeIOS", targets: ["AgenticNativeIOS"]),
    ],
    dependencies: [
        .package(url: "https://github.com/bitmark-inc/tweetnacl-swiftwrap.git", from: "1.1.0"),
    ],
    targets: [
        .executableTarget(
            name: "AgenticNativeIOS",
            dependencies: [
                .product(name: "TweetNacl", package: "tweetnacl-swiftwrap"),
            ]
        ),
    ]
)
