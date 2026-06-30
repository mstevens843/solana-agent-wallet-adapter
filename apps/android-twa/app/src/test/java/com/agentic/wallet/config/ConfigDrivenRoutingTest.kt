package com.agentic.wallet.config

import com.agentic.wallet.mwa.MemoProofRouter
import com.agentic.wallet.mwa.WalletRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves the end-to-end config-driven routing contract: when the server flips a
 * wallet's capability flag in `/api/android-config`, the in-flight APK's
 * `WalletRegistry` + `MemoProofRouter` honor it on the next call.
 *
 * The reverse contract is just as important — if RemoteConfigLoader has no remote
 * snapshot (no cache + server down on first launch), bundled defaults must produce
 * the exact same routing the APK has shipped with for months. Those tests live in
 * the existing [com.agentic.wallet.mwa.MemoProofRouterTest] and
 * [com.agentic.wallet.mwa.WalletRegistryTest], which exercise the defaults via the
 * untouched `RemoteConfigLoader.config()` (initialized to bundled defaults).
 *
 * Each test seeds the loader, runs assertions, and resets in @After so the
 * singleton's state doesn't leak across test classes.
 */
class ConfigDrivenRoutingTest {

    @After
    fun resetLoader() {
        RemoteConfigLoader.resetForTesting()
    }

    @Test
    fun flippingSupportsSignMessages_swapsMemoTxFallback() {
        // Phantom defaults to memo-tx fallback (supportsSignMessages=false). When the
        // server flips that flag — say Phantom ships a fixed sign_messages handler —
        // routing should switch to direct sign_messages WITHOUT a new APK release.
        val phantomFixed = WalletEntry(
            id = 20,
            name = "phantom",
            packageNames = listOf("app.phantom"),
            uriPatterns = listOf("phantom.app"),
            iconSha256First8 = null,
            supportsSignMessages = true,    // ← server change
            supportsSiws = true,
            forceSignThenRpc = false,
        )
        seedConfig(walletRegistry = listOf(phantomFixed))

        assertFalse(
            "phantom should no longer be flagged as messageSigningUnsupported",
            WalletRegistry.messageSigningUnsupported("app.phantom"),
        )
        assertFalse(
            "phantom should no longer route through memo-tx fallback",
            MemoProofRouter.useMemoTxFallback("app.phantom"),
        )
        // The JS-side capability advertisement now reports supported.
        assertTrue(WalletRegistry.reportSignMessageSupported("app.phantom"))
    }

    @Test
    fun togglingForceSignThenRpc_takesEffect() {
        // Backpack defaults to forceSignThenRpc=true. Flip via server.
        val backpackNative = WalletEntry(
            id = 36,
            name = "backpack",
            packageNames = listOf("app.backpack.mobile.standalone", "app.backpack.mobile"),
            uriPatterns = emptyList(),
            iconSha256First8 = null,
            supportsSignMessages = true,
            supportsSiws = true,
            forceSignThenRpc = false,    // ← server change
        )
        seedConfig(walletRegistry = listOf(backpackNative))

        assertFalse(WalletRegistry.forceSignThenRpc("app.backpack.mobile.standalone"))
        assertFalse(WalletRegistry.forceSignThenRpc("app.backpack.mobile"))
    }

    @Test
    fun changingMemoEnvelopePrefix_propagatesToBuilder() {
        // Server can advance the envelope to v2; shipped APKs that fetch the new
        // config emit the new prefix on their next proof. The server's
        // ACCEPTED_ENVELOPE_PREFIXES array must include both v1 (for older APKs) and
        // v2 (for fresh APKs).
        val v2Router = MemoProofRouterConfig(
            envelopeVersion = "v2",
            proofMemoPrefix = "Agentic plan review proof v2\nSHA-256: ",
            fallbackOnBlankPackage = true,
        )
        seedConfig(memoProofRouter = v2Router)

        val envelope = MemoProofRouter.buildProofMemo("test message")
        assertTrue(
            "envelope must use server-supplied v2 prefix",
            envelope.startsWith("Agentic plan review proof v2\nSHA-256: "),
        )
        assertEquals(MemoProofRouter.PROOF_MEMO_PREFIX, "Agentic plan review proof v2\nSHA-256: ")
        // Memo stays fixed-size (prefix + 64-char hex) regardless of message length.
        assertEquals("Agentic plan review proof v2\nSHA-256: ".length + 64, envelope.length)
    }

    @Test
    fun fallbackOnBlankPackage_canBeDisabledViaConfig() {
        // After the JS picker reliably forwards targetWalletPackage, this flag can be
        // flipped off via server so unknown wallets stop defaulting to memo-tx.
        val routerNoBlankFallback = MemoProofRouterConfig(
            envelopeVersion = "v1",
            proofMemoPrefix = "Agentic plan review proof v1\nSHA-256: ",
            fallbackOnBlankPackage = false,    // ← server change
        )
        seedConfig(memoProofRouter = routerNoBlankFallback)

        assertFalse(
            "blank package no longer routes through memo-tx when server disables the fallback",
            MemoProofRouter.useMemoTxFallback(""),
        )
        assertFalse(MemoProofRouter.useMemoTxFallback("   "))
    }

    @Test
    fun unknownWalletPackage_fallsBackToHardcodedHeuristics() {
        // Server config registry only includes Backpack. A request for Phantom must
        // not crash — it falls back to the hardcoded heuristic in WalletRegistry
        // (which contains "phantom" → messageSigningUnsupported = true). The
        // hardcoded heuristic is the safety net for wallets the server didn't ship.
        val backpackOnly = WalletEntry(
            id = 36,
            name = "backpack",
            packageNames = listOf("app.backpack.mobile.standalone", "app.backpack.mobile"),
            uriPatterns = emptyList(),
            iconSha256First8 = null,
            supportsSignMessages = true,
            supportsSiws = true,
            forceSignThenRpc = false,
        )
        seedConfig(walletRegistry = listOf(backpackOnly))

        // Phantom not in config → fall through to hardcoded heuristic
        assertTrue(WalletRegistry.messageSigningUnsupported("app.phantom"))
        assertTrue(MemoProofRouter.useMemoTxFallback("app.phantom"))
        // Backpack in config → server value wins (supportsSignMessages=true so NOT
        // unsupported; forceSignThenRpc=false even though hardcoded says true)
        assertFalse(WalletRegistry.messageSigningUnsupported("app.backpack.mobile.standalone"))
        assertFalse(WalletRegistry.forceSignThenRpc("app.backpack.mobile.standalone"))
        assertFalse(WalletRegistry.messageSigningUnsupported("app.backpack.mobile"))
        assertFalse(WalletRegistry.forceSignThenRpc("app.backpack.mobile"))
    }

    @Test
    fun resetForTesting_restoresBundledDefaults() {
        val mutated = WalletEntry(
            id = 99, name = "x", packageNames = listOf("x.y"), uriPatterns = emptyList(),
            iconSha256First8 = null, supportsSignMessages = true, supportsSiws = false,
            forceSignThenRpc = true,
        )
        seedConfig(walletRegistry = listOf(mutated))
        assertEquals(1, RemoteConfigLoader.config().walletRegistry.size)

        RemoteConfigLoader.resetForTesting()
        assertEquals(
            RemoteConfigDefaults.WALLET_REGISTRY.size,
            RemoteConfigLoader.config().walletRegistry.size,
        )
        assertEquals(ConfigSource.BUNDLED, RemoteConfigLoader.current().source)
    }

    private fun seedConfig(
        version: Int = RemoteConfigDefaults.VERSION,
        walletRegistry: List<WalletEntry> = RemoteConfigDefaults.WALLET_REGISTRY,
        memoProofRouter: MemoProofRouterConfig = RemoteConfigDefaults.MEMO_PROOF_ROUTER,
        featureFlags: Map<String, Boolean> = emptyMap(),
    ) {
        val cfg = RemoteConfig(
            version = version,
            walletRegistry = walletRegistry,
            memoProofRouter = memoProofRouter,
            featureFlags = featureFlags,
        )
        RemoteConfigLoader.setForTesting(
            LoaderSnapshot(
                config = cfg,
                source = ConfigSource.SERVER,
                fetchedAtMs = 1_000_000L,
            ),
        )
        assertNotNull(RemoteConfigLoader.current())
    }
}
