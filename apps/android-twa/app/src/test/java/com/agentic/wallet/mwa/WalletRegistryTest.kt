package com.agentic.wallet.mwa

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WalletRegistryTest {

    @Test
    fun messageSigningUnsupported_phantomFamily() {
        assertTrue(WalletRegistry.messageSigningUnsupported("app.phantom"))
        assertTrue(WalletRegistry.messageSigningUnsupported("App.Phantom"))
        assertTrue(WalletRegistry.messageSigningUnsupported("com.example.phantom-fork"))
    }

    @Test
    fun messageSigningUnsupported_solflareFamily() {
        assertTrue(WalletRegistry.messageSigningUnsupported("com.solflare.mobile"))
        assertTrue(WalletRegistry.messageSigningUnsupported("Solflare"))
    }

    @Test
    fun messageSigningUnsupported_seedVaultFamily() {
        // Reference impl shipped on Seeker dev kits.
        assertTrue(WalletRegistry.messageSigningUnsupported("com.solanamobile.seedvaultimpl"))
        // Plain "seedvault" substring should also match — guards against package-id drift
        // on production Seeker firmware (e.g., a future com.solanamobile.seedvault).
        assertTrue(WalletRegistry.messageSigningUnsupported("seedvault"))
        assertTrue(WalletRegistry.messageSigningUnsupported("SeedVault"))
        assertTrue(WalletRegistry.messageSigningUnsupported("COM.SOLANAMOBILE.SEEDVAULTIMPL"))
    }

    @Test
    fun messageSigningUnsupported_signMessagesCapableWallets() {
        assertFalse(WalletRegistry.messageSigningUnsupported("app.backpack.mobile"))
        assertFalse(WalletRegistry.messageSigningUnsupported("ag.jup.jupiter.android"))
        assertFalse(WalletRegistry.messageSigningUnsupported(""))
        assertFalse(WalletRegistry.messageSigningUnsupported("com.example.unknown"))
        // "solanamobile" without "seedvault" — should NOT over-match. Reserved for any
        // future Solana Mobile wallets that may ship under that namespace.
        assertFalse(WalletRegistry.messageSigningUnsupported("com.solanamobile.somethingelse"))
    }

    @Test
    fun supportsSiws_excludesSolflareAndSeedVault() {
        assertFalse(WalletRegistry.supportsSiws("com.solflare.mobile"))
        assertFalse(WalletRegistry.supportsSiws("com.solanamobile.seedvaultimpl"))
        assertFalse(WalletRegistry.supportsSiws("seedvault"))
    }

    @Test
    fun supportsSiws_includesEveryOtherWallet() {
        assertTrue(WalletRegistry.supportsSiws("app.phantom"))
        assertTrue(WalletRegistry.supportsSiws("app.backpack.mobile"))
        assertTrue(WalletRegistry.supportsSiws("ag.jup.jupiter.android"))
        assertTrue(WalletRegistry.supportsSiws(""))
        assertTrue(WalletRegistry.supportsSiws("com.example.unknown"))
    }

    @Test
    fun inferPackage_mapsUriSchemesToCanonicalPackage() {
        assertEquals("app.phantom", WalletRegistry.inferPackage("https://phantom.app/ul/v1"))
        assertEquals("com.solflare.mobile", WalletRegistry.inferPackage("https://solflare.com"))
        assertEquals("app.backpack.mobile", WalletRegistry.inferPackage("https://backpack.app"))
        assertEquals("ag.jup.jupiter.android", WalletRegistry.inferPackage("https://jup.ag/mwa"))
        assertEquals("com.solanamobile.seedvaultimpl", WalletRegistry.inferPackage("solanamobilewallet://v1"))
    }

    @Test
    fun inferPackage_honorsExplicitPackageOverUri() {
        assertEquals(
            "app.custom.wallet",
            WalletRegistry.inferPackage("https://phantom.app/ul/v1", explicitPackage = "app.custom.wallet"),
        )
    }

    @Test
    fun inferPackage_returnsEmptyForUnknownUri() {
        assertEquals("", WalletRegistry.inferPackage("https://example.com/wallet"))
        assertEquals("", WalletRegistry.inferPackage(""))
    }

    @Test
    fun walletType_packageBased() {
        assertEquals(WalletRegistry.PHANTOM, WalletRegistry.walletType("app.phantom"))
        assertEquals(WalletRegistry.SOLFLARE, WalletRegistry.walletType("com.solflare.mobile"))
        assertEquals(WalletRegistry.BACKPACK, WalletRegistry.walletType("app.backpack.mobile"))
        assertEquals(WalletRegistry.JUPITER, WalletRegistry.walletType("ag.jup.jupiter.android"))
        assertEquals(WalletRegistry.SEED_VAULT, WalletRegistry.walletType("com.solanamobile.seedvaultimpl"))
    }

    @Test
    fun walletType_uriBased() {
        // Even without a package name, the URI base alone should classify the wallet.
        assertEquals(WalletRegistry.SEED_VAULT, WalletRegistry.walletType("", "solanamobilewallet://v1"))
        assertEquals(WalletRegistry.JUPITER, WalletRegistry.walletType("", "https://jup.ag"))
    }

    @Test
    fun walletType_unknownDefault() {
        assertEquals(WalletRegistry.UNKNOWN, WalletRegistry.walletType("com.example.unknown"))
        assertEquals(WalletRegistry.UNKNOWN, WalletRegistry.walletType(""))
    }

    @Test
    fun forceSignThenRpc_backpackAndJupiterOnly() {
        // Seed Vault uses native MWA sign_transactions; should NOT be forced to sign-then-RPC.
        assertFalse(WalletRegistry.forceSignThenRpc("com.solanamobile.seedvaultimpl"))
        // Phantom/Solflare also use native paths.
        assertFalse(WalletRegistry.forceSignThenRpc("app.phantom"))
        assertFalse(WalletRegistry.forceSignThenRpc("com.solflare.mobile"))
        // Backpack and Jupiter route through the resolved Helius RPC.
        assertTrue(WalletRegistry.forceSignThenRpc("app.backpack.mobile"))
        assertTrue(WalletRegistry.forceSignThenRpc("ag.jup.jupiter.android"))
    }
}
