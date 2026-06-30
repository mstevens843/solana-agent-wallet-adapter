package com.agentic.wallet.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the JSON parser that lives between the server payload
 * (`apps/render-web/src/cloud/androidConfig.ts`) and the Kotlin consumers
 * (WalletRegistry, MemoProofRouter). Parser must:
 *   - Round-trip the canonical server payload byte-for-byte semantically.
 *   - Tolerate missing fields by falling back to [RemoteConfigDefaults].
 *   - Tolerate unknown fields so the server can grow without breaking old APKs.
 *   - Reject malformed JSON cleanly (return null, not throw).
 */
class RemoteConfigSchemaTest {

    @Test
    fun parse_canonicalServerPayload_roundTripsAllFields() {
        // Mirror of ANDROID_REMOTE_CONFIG in apps/render-web/src/cloud/androidConfig.ts.
        // Kept literal so a server-side schema change shows up as a test failure here
        // (and vice-versa).
        val canonical = """
            {
              "version": 1,
              "walletRegistry": [
                {"id":20,"name":"phantom","packageNames":["app.phantom"],"uriPatterns":["phantom.app"],"supportsSignMessages":false,"supportsSiws":true,"forceSignThenRpc":false},
                {"id":25,"name":"solflare","packageNames":["com.solflare.mobile"],"uriPatterns":["solflare.com"],"iconSha256First8":"245123d8a7fd8aa5","supportsSignMessages":false,"supportsSiws":false,"forceSignThenRpc":false},
                {"id":36,"name":"backpack","packageNames":["app.backpack.mobile.standalone","app.backpack.mobile"],"uriPatterns":["backpack.app"],"supportsSignMessages":true,"supportsSiws":true,"forceSignThenRpc":true},
                {"id":40,"name":"jupiter","packageNames":["ag.jup.jupiter.android"],"uriPatterns":["jup.ag","jupiter"],"supportsSignMessages":true,"supportsSiws":true,"forceSignThenRpc":true},
                {"id":50,"name":"seedvault","packageNames":["com.solanamobile.seedvaultimpl"],"uriPatterns":["seedvault","seed-vault","seedvaultwallet","solanamobilewallet"],"supportsSignMessages":false,"supportsSiws":false,"forceSignThenRpc":false}
              ],
              "memoProofRouter": {
                "envelopeVersion": "v1",
                "proofMemoPrefix": "Agentic plan review proof v1\nSHA-256: ",
                "fallbackOnBlankPackage": true
              },
              "featureFlags": {"forceMemoTxFallback": false}
            }
        """.trimIndent()

        val parsed = RemoteConfigSchema.parse(canonical)
        assertNotNull("server payload must parse", parsed)
        requireNotNull(parsed)
        assertEquals(1, parsed.version)
        assertEquals(5, parsed.walletRegistry.size)
        assertEquals("Agentic plan review proof v1\nSHA-256: ", parsed.memoProofRouter.proofMemoPrefix)
        assertEquals("v1", parsed.memoProofRouter.envelopeVersion)
        assertTrue(parsed.memoProofRouter.fallbackOnBlankPackage)
        // PARITY: kill-switch flag round-trips with the documented default.
        assertEquals(false, parsed.featureFlags["forceMemoTxFallback"])

        val phantom = parsed.walletEntryByPackage("app.phantom")
        assertNotNull(phantom)
        requireNotNull(phantom)
        assertEquals(20, phantom.id)
        assertEquals(false, phantom.supportsSignMessages)
        assertEquals(true, phantom.supportsSiws)
        assertEquals(false, phantom.forceSignThenRpc)

        val backpack = parsed.walletEntryByPackage("app.backpack.mobile")
        assertNotNull(backpack)
        requireNotNull(backpack)
        assertEquals(true, backpack.supportsSignMessages)
        assertEquals(true, backpack.forceSignThenRpc)
        assertEquals(backpack, parsed.walletEntryByPackage("app.backpack.mobile.standalone"))
    }

    @Test
    fun parse_returnsNull_onMalformedJson() {
        assertNull(RemoteConfigSchema.parse(""))
        assertNull(RemoteConfigSchema.parse("not-json"))
        assertNull(RemoteConfigSchema.parse("{"))
    }

    @Test
    fun parse_fallsBackToDefaults_whenWalletRegistryMissing() {
        val payload = """{"version":2,"memoProofRouter":{"envelopeVersion":"v1","proofMemoPrefix":"X","fallbackOnBlankPackage":true}}"""
        val parsed = RemoteConfigSchema.parse(payload)
        assertNotNull(parsed)
        requireNotNull(parsed)
        // Server omitted walletRegistry; we keep working with bundled defaults instead
        // of producing an empty registry that would route every wallet through the
        // unknown-package path.
        assertEquals(RemoteConfigDefaults.WALLET_REGISTRY.size, parsed.walletRegistry.size)
        assertEquals(2, parsed.version)
        // memoProofRouter was provided — server's value wins
        assertEquals("X", parsed.memoProofRouter.proofMemoPrefix)
    }

    @Test
    fun parse_fallsBackToDefaults_whenWalletRegistryEmpty() {
        val payload = """{"version":1,"walletRegistry":[]}"""
        val parsed = RemoteConfigSchema.parse(payload)
        assertNotNull(parsed)
        requireNotNull(parsed)
        // Empty array would brick routing — same fallback as missing.
        assertEquals(RemoteConfigDefaults.WALLET_REGISTRY.size, parsed.walletRegistry.size)
    }

    @Test
    fun parse_fallsBackToDefaults_whenMemoProofRouterMissing() {
        val payload = """{"version":1,"walletRegistry":[{"id":99,"name":"x","packageNames":["x.y"],"uriPatterns":[],"supportsSignMessages":true,"supportsSiws":true,"forceSignThenRpc":false}]}"""
        val parsed = RemoteConfigSchema.parse(payload)
        assertNotNull(parsed)
        requireNotNull(parsed)
        assertEquals(RemoteConfigDefaults.MEMO_PROOF_ROUTER.proofMemoPrefix, parsed.memoProofRouter.proofMemoPrefix)
        assertEquals(RemoteConfigDefaults.MEMO_PROOF_ROUTER.envelopeVersion, parsed.memoProofRouter.envelopeVersion)
        // The single wallet entry we provided is preserved.
        assertEquals(1, parsed.walletRegistry.size)
        assertEquals("x", parsed.walletRegistry[0].name)
    }

    @Test
    fun parse_toleratesForwardCompatUnknownFields() {
        // Server may grow new fields ahead of an APK release. Parser must ignore them
        // and keep working — old APKs in the dApp Store can't be force-updated.
        val payload = """
            {
              "version": 7,
              "unknownTopLevel": "ignore-me",
              "walletRegistry": [
                {"id":20,"name":"phantom","packageNames":["app.phantom"],"uriPatterns":[],"supportsSignMessages":false,"supportsSiws":true,"forceSignThenRpc":false,"newField":"future"}
              ],
              "memoProofRouter": {
                "envelopeVersion":"v2",
                "proofMemoPrefix":"P",
                "fallbackOnBlankPackage": false,
                "extraField": 99
              },
              "featureFlags": {"betaTradePlanner": true, "broken": "not-a-boolean"}
            }
        """.trimIndent()

        val parsed = RemoteConfigSchema.parse(payload)
        assertNotNull(parsed)
        requireNotNull(parsed)
        assertEquals(7, parsed.version)
        assertEquals("v2", parsed.memoProofRouter.envelopeVersion)
        assertEquals("P", parsed.memoProofRouter.proofMemoPrefix)
        assertEquals(false, parsed.memoProofRouter.fallbackOnBlankPackage)
        // Feature flags coerced: only Boolean values pass through; "not-a-boolean" is dropped.
        assertEquals(true, parsed.featureFlags["betaTradePlanner"])
        assertEquals(false, parsed.featureFlags.containsKey("broken"))
    }

    @Test
    fun parse_skrFeatureFlags_areReadableViaFeatureFlagMap() {
        // Forward-compat contract test for the Solana Mobile Seeker ($SKR)
        // ecosystem-token feature flags. The server emits these only when
        // `SKR_TOKEN_MINT` is set on Render; they are NOT bundled into
        // `RemoteConfigDefaults.FEATURE_FLAGS` (which mirrors only the
        // operator kill-switches that ship with the APK). This test pins the
        // round-trip parsing of the three SKR flags so a future refactor to
        // `parseFeatureFlags` can't silently drop them.
        val payload = """
            {
              "version": 1,
              "walletRegistry": [
                {"id":50,"name":"seedvault","packageNames":["com.solanamobile.seedvaultimpl"],"uriPatterns":[],"supportsSignMessages":false,"supportsSiws":false,"forceSignThenRpc":false}
              ],
              "memoProofRouter": {"envelopeVersion":"v1","proofMemoPrefix":"Agentic plan review proof v1\nSHA-256: ","fallbackOnBlankPackage":true},
              "featureFlags": {
                "forceMemoTxFallback": false,
                "skrEnabled": true,
                "skrSkillBountyActive": true,
                "skrSessionDefault": false
              }
            }
        """.trimIndent()

        val parsed = RemoteConfigSchema.parse(payload)
        assertNotNull(parsed)
        requireNotNull(parsed)
        // Static slice still present.
        assertEquals(false, parsed.featureFlags["forceMemoTxFallback"])
        // Env-conditional SKR flags propagate verbatim — independently
        // togglable, never coalesced with `skrEnabled`.
        assertEquals(true, parsed.featureFlags["skrEnabled"])
        assertEquals(true, parsed.featureFlags["skrSkillBountyActive"])
        assertEquals(false, parsed.featureFlags["skrSessionDefault"])
    }

    @Test
    fun parse_proofMemoPrefix_blankStringFallsBackToDefault() {
        val payload = """{"version":1,"memoProofRouter":{"envelopeVersion":"v9","proofMemoPrefix":"","fallbackOnBlankPackage":true}}"""
        val parsed = RemoteConfigSchema.parse(payload)
        assertNotNull(parsed)
        requireNotNull(parsed)
        // A blank prefix would silently invalidate every proof — fall back to bundled
        // default so the server can't accidentally brick proof signing with a typo.
        assertEquals(RemoteConfigDefaults.MEMO_PROOF_ROUTER.proofMemoPrefix, parsed.memoProofRouter.proofMemoPrefix)
        assertEquals("v9", parsed.memoProofRouter.envelopeVersion)
    }

    @Test
    fun parse_nonBooleanCoercibleFieldTypes_useDefaults() {
        // Server-side type-mismatch guard: if a config field that should be boolean
        // arrives as a number, array, object, or null (e.g., a botched TS literal
        // like `supportsSignMessages: null`), the parser falls back to the per-field
        // default rather than producing a misrouted entry.
        //
        // Note: JSONObject.optBoolean DOES coerce the strings "true"/"false" to
        // booleans (org.json lenient behavior), so a value of "true"/"false" is
        // treated as the corresponding boolean — that's intentional and matches
        // many YAML/JSON workflows. This test covers the OTHER mismatches.
        val payload = """
            {
              "version": 1,
              "walletRegistry": [
                {"id":99,"name":"buggy","packageNames":["x.y"],"uriPatterns":[],"supportsSignMessages":null,"supportsSiws":0,"forceSignThenRpc":[1,2,3]}
              ],
              "memoProofRouter": {"envelopeVersion":"v1","proofMemoPrefix":"Agentic plan review proof v1\nSHA-256: ","fallbackOnBlankPackage":true},
              "featureFlags": {}
            }
        """.trimIndent()
        val parsed = RemoteConfigSchema.parse(payload)
        assertNotNull(parsed)
        requireNotNull(parsed)
        val buggy = parsed.walletRegistry.firstOrNull { it.name == "buggy" }
        assertNotNull(buggy)
        requireNotNull(buggy)
        // null → safe default (false → routes through memo-tx fallback)
        assertEquals(false, buggy.supportsSignMessages)
        // 0 (number) → not a boolean — falls back to the parser default (`true`)
        assertEquals(true, buggy.supportsSiws)
        // array → not a boolean — falls back to default (`false`)
        assertEquals(false, buggy.forceSignThenRpc)
    }

    @Test
    fun walletEntryByPackage_caseInsensitiveLookup() {
        val cfg = RemoteConfigDefaults.DEFAULT_CONFIG
        assertEquals("phantom", cfg.walletEntryByPackage("APP.PHANTOM")?.name)
        assertEquals("phantom", cfg.walletEntryByPackage("app.phantom")?.name)
        assertNull(cfg.walletEntryByPackage(""))
        assertNull(cfg.walletEntryByPackage("unknown.wallet.pkg"))
    }

    @Test
    fun defaults_proofMemoPrefix_matchesServerInvariant() {
        // CONTRACT ANCHOR: this literal string must equal what the server emits in
        // apps/render-web/src/cloud/androidConfig.ts MEMO_PROOF_ROUTER, and must be
        // present in the server's auth.ts ACCEPTED_ENVELOPE_PREFIXES. If any of those
        // three diverges, the cross-contract test
        // android-config-api.test.ts::"publishes a memo-proof prefix that the verifier
        // accepts" catches the server side; this test catches the Android side.
        assertEquals(
            "Agentic plan review proof v1\nSHA-256: ",
            RemoteConfigDefaults.MEMO_PROOF_ROUTER.proofMemoPrefix,
        )
        assertEquals("v1", RemoteConfigDefaults.MEMO_PROOF_ROUTER.envelopeVersion)
        assertTrue(RemoteConfigDefaults.MEMO_PROOF_ROUTER.fallbackOnBlankPackage)
    }

    @Test
    fun defaults_walletRegistry_matchesServerCanonicalPayload() {
        // PARITY ANCHOR: bundled defaults are the safety net for "APK on first launch
        // with server unreachable" — and for an APK whose remote config was wiped from
        // disk. They must match the server's canonical /api/android-config payload
        // field-by-field, otherwise a user could see different routing depending on
        // whether the server was reachable at first launch.
        //
        // Update both this list AND apps/render-web/src/cloud/androidConfig.ts in
        // lockstep when you add a wallet or flip a flag.
        val expected = listOf(
            ExpectedWallet(20, "phantom", listOf("app.phantom"), false, true, false),
            ExpectedWallet(25, "solflare", listOf("com.solflare.mobile"), false, false, false),
            ExpectedWallet(36, "backpack", listOf("app.backpack.mobile.standalone", "app.backpack.mobile"), true, true, true),
            ExpectedWallet(40, "jupiter", listOf("ag.jup.jupiter.android"), true, true, true),
            ExpectedWallet(50, "seedvault", listOf("com.solanamobile.seedvaultimpl"), false, false, false),
        )
        val bundled = RemoteConfigDefaults.WALLET_REGISTRY
        assertEquals(
            "bundled defaults wallet count must match server canonical payload",
            expected.size,
            bundled.size,
        )
        expected.zip(bundled).forEach { (exp, actual) ->
            assertEquals("wallet id for ${exp.name}", exp.id, actual.id)
            assertEquals("wallet name", exp.name, actual.name)
            assertEquals("packageNames for ${exp.name}", exp.packageNames, actual.packageNames)
            assertEquals("supportsSignMessages for ${exp.name}", exp.supportsSignMessages, actual.supportsSignMessages)
            assertEquals("supportsSiws for ${exp.name}", exp.supportsSiws, actual.supportsSiws)
            assertEquals("forceSignThenRpc for ${exp.name}", exp.forceSignThenRpc, actual.forceSignThenRpc)
        }
        // Solflare icon fingerprint anchor — used by inferPackage when walletPackage
        // is blank and the icon is the canonical Solflare PNG.
        assertEquals("245123d8a7fd8aa5", bundled.first { it.name == "solflare" }.iconSha256First8)
        // Operator kill-switch defaults — must match server FEATURE_FLAGS in
        // apps/render-web/src/cloud/androidConfig.ts. Bundled defaults are the
        // safety net while config refresh is pending or offline.
        assertEquals(false, RemoteConfigDefaults.FEATURE_FLAGS["forceMemoTxFallback"])
        assertEquals(
            "bundled defaults feature-flag set must mirror server payload exactly",
            RemoteConfigDefaults.FEATURE_FLAGS,
            RemoteConfigDefaults.DEFAULT_CONFIG.featureFlags,
        )
    }

    private data class ExpectedWallet(
        val id: Int,
        val name: String,
        val packageNames: List<String>,
        val supportsSignMessages: Boolean,
        val supportsSiws: Boolean,
        val forceSignThenRpc: Boolean,
    )
}
