package com.agentic.wallet.mwa

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WalletRegistryTest {
    private val seedVaultIcon =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANgAAADY..." +
            "QChlppOaiUo1Z22pIwKl0xN6leqUK+T8P/q4PWPnCdaVAAAAAElFTkSuQmCC"

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
    fun inferPackage_mapsWalletIconsToCanonicalPackage() {
        assertEquals(
            "com.solflare.mobile",
            WalletRegistry.inferPackage("", walletIcon = "https://solflare.com/favicon.ico"),
        )
        assertEquals(
            "com.solanamobile.seedvaultimpl",
            WalletRegistry.inferPackage("", walletIcon = "https://intercom.help/seedvaultwallet/assets/favicon"),
        )
        assertEquals(
            "com.solanamobile.seedvaultimpl",
            WalletRegistry.inferPackage("", walletIcon = seedVaultIcon),
        )
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
    fun walletType_iconBased() {
        assertEquals(WalletRegistry.SOLFLARE, WalletRegistry.walletType("", walletIcon = "https://solflare.com/favicon.ico"))
        assertEquals(WalletRegistry.SEED_VAULT, WalletRegistry.walletType("", walletIcon = "https://intercom.help/seedvaultwallet/assets/favicon"))
        assertEquals(WalletRegistry.SEED_VAULT, WalletRegistry.walletType("", walletIcon = seedVaultIcon))
    }

    @Test
    fun walletIconLogMetadata_redactsSeedVaultIcon() {
        val metadata = WalletRegistry.walletIconLogMetadata(seedVaultIcon)
        assertEquals("data-image", metadata["walletIconKind"])
        assertEquals(seedVaultIcon.length, metadata["walletIconChars"])
        assertTrue(metadata["walletIconKnownSeedVault"] == true)
        assertFalse(metadata.values.contains(seedVaultIcon))
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

    // The capabilitiesJson policy. False for blank/unknown packages (the Seeker production
    // case — MWA SDK returns no caller package and Seeker Wallet returns no walletUriBase,
    // so walletPackage is empty in the auth record) and for the broken-sign-messages
    // list; true only for wallets we've fingerprinted AND verified as known-good.
    @Test
    fun reportSignMessageSupported_blankWalletPackageReturnsFalse() {
        // The actual Seeker production flow lands here: walletPackage="" because the MWA
        // SDK doesn't return a caller package and Seeker Wallet returns no walletUriBase.
        // Reporting `signMessage: true` for this case routed JS into a hung-approval bug
        // (see device logcat in plan file: signMessages | FAIL_WALLET_RESULT WALLET_CRASHED
        // CancellationException at MwaController.kt:490). Default to false so the JS gate
        // flips and the memo-tx fallback fires.
        assertFalse(WalletRegistry.reportSignMessageSupported(""))
        assertFalse(WalletRegistry.reportSignMessageSupported("   "))
    }

    @Test
    fun reportSignMessageSupported_brokenWalletsReturnFalse() {
        assertFalse(WalletRegistry.reportSignMessageSupported("app.phantom"))
        assertFalse(WalletRegistry.reportSignMessageSupported("com.solflare.mobile"))
        assertFalse(WalletRegistry.reportSignMessageSupported("com.solanamobile.seedvaultimpl"))
        assertFalse(WalletRegistry.reportSignMessageSupported("seedvault"))
    }

    @Test
    fun reportSignMessageSupported_knownGoodWalletsReturnTrue() {
        // Backpack and Jupiter have working signMessages handlers; they should keep their
        // direct path (not be routed through memo-tx).
        assertTrue(WalletRegistry.reportSignMessageSupported("app.backpack.mobile"))
        assertTrue(WalletRegistry.reportSignMessageSupported("ag.jup.jupiter.android"))
    }

    @Test
    fun reportSignMessageSupported_unknownButNonBlankPackageReturnsTrue() {
        // A non-blank package that isn't on the broken list is given the benefit of the
        // doubt — we don't have evidence it's broken, and the blank-package guard already
        // catches the "we don't know what this is" case.
        assertTrue(WalletRegistry.reportSignMessageSupported("com.example.unknown-but-non-blank"))
    }
}
