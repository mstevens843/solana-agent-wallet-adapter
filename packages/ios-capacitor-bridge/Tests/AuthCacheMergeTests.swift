import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class AuthCacheMergeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        AgenticAuthCache().clearAll()
    }

    override func tearDown() {
        AgenticAuthCache().clearAll()
        super.tearDown()
    }

    func testPreservesCachedAuthorizationFieldsWhenIncomingRecordIsPartial() {
        let existing = authRecord(
            publicKey: "Phantom111111111111111111111111111111111",
            walletID: .phantom,
            timestamp: 1,
            session: "cached-session",
            walletEncryptionPublicKey: "cached-wallet-key",
            sharedSecret: "cached-shared-secret",
            dappPublicKey: "cached-dapp-pubkey",
            dappSecretKey: "cached-dapp-secret",
            walletConnectTopic: "cached-topic"
        )
        let partial = authRecord(
            publicKey: "Phantom111111111111111111111111111111111",
            walletID: .phantom,
            timestamp: 2,
            session: "",
            walletEncryptionPublicKey: nil,
            sharedSecret: "",
            dappPublicKey: nil,
            dappSecretKey: "",
            walletConnectTopic: nil
        )

        let merged = AgenticAuthCache.mergedRecord(partial, existing: existing)

        XCTAssertEqual(merged.sessionBase58, "cached-session")
        XCTAssertEqual(merged.walletEncryptionPublicKeyBase58, "cached-wallet-key")
        XCTAssertEqual(merged.sharedSecretBase64, "cached-shared-secret")
        XCTAssertEqual(merged.dappPublicKeyBase64, "cached-dapp-pubkey")
        XCTAssertEqual(merged.dappSecretKeyBase64, "cached-dapp-secret")
        XCTAssertEqual(merged.walletConnectTopic, "cached-topic")
        XCTAssertEqual(merged.timestampUnixSeconds, 2)
        XCTAssertTrue(merged.authenticated)
    }

    func testDoesNotMergeAuthorizationFieldsAcrossWallets() {
        let existing = authRecord(
            publicKey: "Shared1111111111111111111111111111111111",
            walletID: .phantom,
            timestamp: 1,
            session: "cached-session"
        )
        let incoming = authRecord(
            publicKey: "Shared1111111111111111111111111111111111",
            walletID: .solflare,
            timestamp: 2,
            session: ""
        )

        let merged = AgenticAuthCache.mergedRecord(incoming, existing: existing)

        XCTAssertEqual(merged.walletID, .solflare)
        XCTAssertEqual(merged.sessionBase58, "")
    }

    func testSetPreservesCachedAuthorizationFieldsWhenDisconnectRecordIsPartial() {
        let cache = AgenticAuthCache()
        let existing = authRecord(
            publicKey: "Disconnect111111111111111111111111111111",
            walletID: .phantom,
            timestamp: 1,
            session: "cached-session",
            walletEncryptionPublicKey: "cached-wallet-key",
            sharedSecret: "cached-shared-secret",
            dappPublicKey: "cached-dapp-pubkey",
            dappSecretKey: "cached-dapp-secret"
        )
        let disconnected = authRecord(
            publicKey: existing.publicKey,
            walletID: .phantom,
            timestamp: 2,
            session: "",
            walletEncryptionPublicKey: nil,
            sharedSecret: "",
            dappPublicKey: nil,
            dappSecretKey: "",
            authenticated: false
        )

        cache.set(existing)
        cache.set(disconnected)

        let cached = cache.summary().latest
        XCTAssertEqual(cached?.sessionBase58, "cached-session")
        XCTAssertEqual(cached?.walletEncryptionPublicKeyBase58, "cached-wallet-key")
        XCTAssertEqual(cached?.sharedSecretBase64, "cached-shared-secret")
        XCTAssertEqual(cached?.dappPublicKeyBase64, "cached-dapp-pubkey")
        XCTAssertEqual(cached?.dappSecretKeyBase64, "cached-dapp-secret")
        XCTAssertEqual(cached?.timestampUnixSeconds, 2)
        XCTAssertEqual(cached?.authenticated, false)
    }

    func testExplicitClearRemovesCachedAuthorizationFields() {
        let cache = AgenticAuthCache()
        let existing = authRecord(
            publicKey: "Clear111111111111111111111111111111111",
            walletID: .phantom,
            timestamp: 1,
            session: "cached-session"
        )

        cache.set(existing)
        cache.clear(publicKey: existing.publicKey)

        let summary = cache.summary()
        XCTAssertEqual(summary.count, 0)
        XCTAssertNil(summary.latest)
    }

    private func authRecord(
        publicKey: String,
        walletID: AgenticWalletID,
        timestamp: Int,
        session: String?,
        walletEncryptionPublicKey: String? = "wallet-key",
        sharedSecret: String? = "shared-secret",
        dappPublicKey: String? = "dapp-pubkey",
        dappSecretKey: String? = "dapp-secret",
        walletConnectTopic: String? = nil,
        authenticated: Bool = true
    ) -> AgenticAuthRecord {
        AgenticAuthRecord(
            publicKey: publicKey,
            walletID: walletID,
            walletName: walletID.descriptor.name,
            cluster: .mainnetBeta,
            sessionBase58: session,
            walletEncryptionPublicKeyBase58: walletEncryptionPublicKey,
            sharedSecretBase64: sharedSecret,
            dappPublicKeyBase64: dappPublicKey,
            dappSecretKeyBase64: dappSecretKey,
            walletConnectTopic: walletConnectTopic,
            timestampUnixSeconds: timestamp,
            authenticated: authenticated
        )
    }
}
