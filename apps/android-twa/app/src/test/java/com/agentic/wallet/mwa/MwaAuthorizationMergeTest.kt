package com.agentic.wallet.mwa

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MwaAuthorizationMergeTest {

    @Test
    fun buildAppliedAuthorizationRecord_preservesExistingAuthTokenWhenWalletOmitsToken() {
        val publicKeyBytes = ByteArray(32) { 11 }
        val publicKeyBase58 = Base58.encode(publicKeyBytes)
        val existing = AgentMwaAuthRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            authToken = "cached-auth-token",
            walletUriBase = "https://jup.ag/ul/v1",
            walletIcon = "https://jup.ag/favicon.ico",
            walletPackage = "ag.jup.jupiter.android",
            walletType = WalletRegistry.JUPITER,
            accountLabel = "Jupiter signer",
            cluster = AgentCluster.MainnetBeta,
            timestampUnixSeconds = 1_716_000_000L,
            authenticated = true,
            capabilitiesCsv = "sign_transactions,sign_messages",
        )

        val merged = buildAppliedAuthorizationRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            incomingAuthToken = "",
            walletUriBase = "",
            walletIcon = "",
            targetWalletPackage = "ag.jup.jupiter.android",
            accountLabel = "",
            cluster = AgentCluster.MainnetBeta,
            existing = existing,
            capabilitiesCsv = "",
            timestampUnixSeconds = 1_716_000_100L,
        )

        assertEquals("cached-auth-token", merged.authToken)
        assertEquals("https://jup.ag/ul/v1", merged.walletUriBase)
        assertEquals("https://jup.ag/favicon.ico", merged.walletIcon)
        assertEquals("ag.jup.jupiter.android", merged.walletPackage)
        assertEquals(WalletRegistry.JUPITER, merged.walletType)
        assertEquals("Jupiter signer", merged.accountLabel)
        assertEquals("sign_transactions,sign_messages", merged.capabilitiesCsv)
        assertTrue(merged.hasUsableAuthorization())
    }

    @Test
    fun buildAppliedAuthorizationRecord_usesFreshAuthTokenWhenPresent() {
        val publicKeyBytes = ByteArray(32) { 12 }
        val publicKeyBase58 = Base58.encode(publicKeyBytes)
        val existing = AgentMwaAuthRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            authToken = "old-auth-token",
        )

        val merged = buildAppliedAuthorizationRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            incomingAuthToken = "new-auth-token",
            walletUriBase = "https://phantom.app/ul/v1",
            walletIcon = "",
            targetWalletPackage = "app.phantom",
            accountLabel = "Fresh signer",
            cluster = AgentCluster.MainnetBeta,
            existing = existing,
            capabilitiesCsv = "",
            timestampUnixSeconds = 1_716_000_100L,
        )

        assertEquals("new-auth-token", merged.authToken)
        assertEquals("Fresh signer", merged.accountLabel)
        assertEquals("app.phantom", merged.walletPackage)
        assertTrue(merged.hasUsableAuthorization())
    }

    @Test
    fun buildAppliedAuthorizationRecord_doesNotInheritProviderMetadataWithoutMatchingExistingRecord() {
        val publicKeyBytes = ByteArray(32) { 13 }
        val publicKeyBase58 = Base58.encode(publicKeyBytes)

        val freshUnknownProvider = buildAppliedAuthorizationRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            incomingAuthToken = "phantom-auth-token",
            walletUriBase = "",
            walletIcon = "",
            targetWalletPackage = "",
            accountLabel = "",
            cluster = AgentCluster.MainnetBeta,
            existing = null,
            capabilitiesCsv = "",
            timestampUnixSeconds = 1_716_000_100L,
        )

        assertEquals("phantom-auth-token", freshUnknownProvider.authToken)
        assertEquals("", freshUnknownProvider.walletUriBase)
        assertEquals("", freshUnknownProvider.walletIcon)
        assertEquals("", freshUnknownProvider.walletPackage)
        assertEquals(WalletRegistry.UNKNOWN, freshUnknownProvider.walletType)
    }

    @Test
    fun buildAppliedAuthorizationRecord_doesNotInheritDifferentProviderMetadataForSamePubkey() {
        val publicKeyBytes = ByteArray(32) { 14 }
        val publicKeyBase58 = Base58.encode(publicKeyBytes)
        val existingSeedVault = AgentMwaAuthRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            authToken = "seed-auth-token",
            walletUriBase = "solanamobilewallet://wallet",
            walletIcon = "seed-icon",
            walletPackage = "com.solanamobile.seedvaultimpl",
            walletType = WalletRegistry.SEED_VAULT,
            accountLabel = "Seed Vault signer",
            cluster = AgentCluster.MainnetBeta,
            timestampUnixSeconds = 1_716_000_000L,
            authenticated = true,
            capabilitiesCsv = "sign_transactions",
        )

        val freshPhantom = buildAppliedAuthorizationRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            incomingAuthToken = "phantom-auth-token",
            walletUriBase = "",
            walletIcon = "",
            targetWalletPackage = "app.phantom",
            accountLabel = "Phantom signer",
            cluster = AgentCluster.MainnetBeta,
            existing = existingSeedVault,
            capabilitiesCsv = "",
            timestampUnixSeconds = 1_716_000_100L,
        )

        assertEquals("phantom-auth-token", freshPhantom.authToken)
        assertEquals("", freshPhantom.walletUriBase)
        assertEquals("", freshPhantom.walletIcon)
        assertEquals("app.phantom", freshPhantom.walletPackage)
        assertEquals(WalletRegistry.PHANTOM, freshPhantom.walletType)
        assertEquals("Phantom signer", freshPhantom.accountLabel)
        assertEquals("", freshPhantom.capabilitiesCsv)
    }
}
