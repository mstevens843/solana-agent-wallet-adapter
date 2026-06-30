package com.agentic.wallet.mwa

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthCacheSerializationTest {

    @Test
    fun authRecordJson_roundTripsWalletMetadata() {
        val publicKeyBytes = ByteArray(32) { 7 }
        val record = AgentMwaAuthRecord(
            publicKeyBase58 = Base58.encode(publicKeyBytes),
            publicKeyBytes = publicKeyBytes,
            authToken = "auth-token",
            walletUriBase = "https://solflare.com/ul/v1",
            walletIcon = "https://solflare.com/favicon.ico",
            walletPackage = "com.solflare.mobile",
            walletType = WalletRegistry.SOLFLARE,
            accountLabel = "Trading wallet",
            cluster = AgentCluster.MainnetBeta,
            timestampUnixSeconds = 1_716_000_000L,
            authenticated = true,
            capabilitiesCsv = "sign_transactions,sign_messages",
        )

        val restored = authRecordFromJson(authRecordToJson(record))

        assertEquals(record.publicKeyBase58, restored.publicKeyBase58)
        assertEquals(record.authToken, restored.authToken)
        assertEquals(record.walletUriBase, restored.walletUriBase)
        assertEquals(record.walletIcon, restored.walletIcon)
        assertEquals(record.walletPackage, restored.walletPackage)
        assertEquals(record.walletType, restored.walletType)
        assertEquals(record.accountLabel, restored.accountLabel)
        assertEquals(record.cluster, restored.cluster)
        assertEquals(record.timestampUnixSeconds, restored.timestampUnixSeconds)
        assertEquals(record.authenticated, restored.authenticated)
        assertEquals(record.capabilitiesCsv, restored.capabilitiesCsv)
    }

    @Test
    fun authRecordFromJson_infersWalletTypeFromPersistedIconForOldRecords() {
        val publicKeyBytes = ByteArray(32) { 9 }
        val json = JSONObject()
            .put("publicKeyBase58", Base58.encode(publicKeyBytes))
            .put("publicKeyBytesBase58", Base58.encode(publicKeyBytes))
            .put("authToken", "auth-token")
            .put("walletUriBase", "")
            .put("walletIcon", "https://intercom.help/seedvaultwallet/assets/favicon")
            .put("walletPackage", "")
            .put("accountLabel", "cofeelme.skr")
            .put("cluster", "mainnet-beta")
            .put("timestampUnixSeconds", 1_716_000_000L)
            .put("authenticated", true)

        val restored = authRecordFromJson(json)

        assertEquals("com.solanamobile.seedvaultimpl", restored.walletPackage)
        assertEquals("https://intercom.help/seedvaultwallet/assets/favicon", restored.walletIcon)
        assertEquals(WalletRegistry.SEED_VAULT, restored.walletType)
    }

    @Test
    fun authRecordFromJson_treatsOldTokenRecordsAsRestorableWhenAuthenticatedFieldMissing() {
        val publicKeyBytes = ByteArray(32) { 10 }
        val json = JSONObject()
            .put("publicKeyBase58", Base58.encode(publicKeyBytes))
            .put("publicKeyBytesBase58", Base58.encode(publicKeyBytes))
            .put("authToken", "legacy-auth-token")
            .put("walletPackage", "app.phantom")
            .put("cluster", "mainnet-beta")
            .put("timestampUnixSeconds", 1_716_000_000L)

        val restored = authRecordFromJson(json)

        assertTrue(restored.authenticated)
        assertTrue(restored.hasUsableAuthorization())
        assertTrue(restored.hasRestorableAuthorization())
    }

    @Test
    fun authRecordFromJson_keepsExplicitlyDisconnectedRecordsNonRestorable() {
        val publicKeyBytes = ByteArray(32) { 12 }
        val json = JSONObject()
            .put("publicKeyBase58", Base58.encode(publicKeyBytes))
            .put("publicKeyBytesBase58", Base58.encode(publicKeyBytes))
            .put("authToken", "cached-auth-token")
            .put("walletPackage", "app.phantom")
            .put("cluster", "mainnet-beta")
            .put("timestampUnixSeconds", 1_716_000_000L)
            .put("authenticated", false)

        val restored = authRecordFromJson(json)

        assertFalse(restored.authenticated)
        assertTrue(restored.hasUsableAuthorization())
        assertFalse(restored.hasRestorableAuthorization())
    }

    @Test
    fun authRecord_requiresAuthenticatedUsableTokenToBeRestorable() {
        val publicKeyBytes = ByteArray(32) { 14 }
        val base = AgentMwaAuthRecord(
            publicKeyBase58 = Base58.encode(publicKeyBytes),
            publicKeyBytes = publicKeyBytes,
            authToken = "cached-auth-token",
            walletPackage = "app.phantom",
            cluster = AgentCluster.MainnetBeta,
            timestampUnixSeconds = 1_716_000_000L,
            authenticated = true,
        )

        assertTrue(base.hasRestorableAuthorization())
        assertFalse(base.copy(authenticated = false).hasRestorableAuthorization())
        assertFalse(base.copy(authToken = "").hasRestorableAuthorization())
        assertFalse(base.copy(publicKeyBase58 = "").hasRestorableAuthorization())
    }

    @Test
    fun authCacheSessionKey_separatesProvidersWithTheSamePubkey() {
        val publicKeyBytes = ByteArray(32) { 13 }
        val publicKeyBase58 = Base58.encode(publicKeyBytes)
        val seedVault = AgentMwaAuthRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            walletPackage = "com.solanamobile.seedvaultimpl",
            walletType = WalletRegistry.SEED_VAULT,
            cluster = AgentCluster.MainnetBeta,
        )
        val phantom = AgentMwaAuthRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            walletPackage = "app.phantom",
            walletType = WalletRegistry.PHANTOM,
            cluster = AgentCluster.MainnetBeta,
        )

        assertFalse(authCacheSessionKey(seedVault) == authCacheSessionKey(phantom))
        assertEquals("mainnet-beta|pkg:com.solanamobile.seedvaultimpl|$publicKeyBase58", authCacheSessionKey(seedVault))
        assertEquals("mainnet-beta|pkg:app.phantom|$publicKeyBase58", authCacheSessionKey(phantom))
    }
}
