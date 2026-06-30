package com.agentic.wallet.mwa

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MwaIdentityPreflightTest {
    private val fingerprint =
        "11:99:47:93:2D:24:79:E3:DD:AE:C3:E4:55:6B:37:56:61:47:0D:FD:24:65:68:F6:2E:66:D7:AE:28:97:CE:EE"
    private val otherFingerprint =
        "B6:E1:07:D1:AB:F2:84:B3:11:B8:48:0A:14:83:9E:0A:12:EA:58:ED:F6:D4:9A:EE:A3:3D:33:7B:B3:E9:30:97"

    @Test
    fun inspectAssetLinksJson_matchesPackageAndFingerprint() {
        val result = MwaIdentityPreflight.inspectAssetLinksJson(
            text = assetLinksJson("com.agentic.wallet", fingerprint),
            appPackage = "com.agentic.wallet",
            expectedFingerprints = listOf(fingerprint.lowercase().replace(":", "")),
        )

        assertTrue(result.parseOk)
        assertTrue(result.packageEntryFound)
        assertTrue(result.relationFound)
        assertTrue(result.namespaceOk)
        assertTrue(result.fingerprintMatch)
        assertEquals(listOf(fingerprint), result.matchedFingerprints)
    }

    @Test
    fun inspectAssetLinksJson_missingPackageDoesNotMatch() {
        val result = MwaIdentityPreflight.inspectAssetLinksJson(
            text = assetLinksJson("trade.solpulse.app", fingerprint),
            appPackage = "com.agentic.wallet",
            expectedFingerprints = listOf(fingerprint),
        )

        assertTrue(result.parseOk)
        assertFalse(result.packageEntryFound)
        assertFalse(result.fingerprintMatch)
    }

    @Test
    fun inspectAssetLinksJson_missingFingerprintDoesNotMatch() {
        val result = MwaIdentityPreflight.inspectAssetLinksJson(
            text = assetLinksJson("com.agentic.wallet", otherFingerprint),
            appPackage = "com.agentic.wallet",
            expectedFingerprints = listOf(fingerprint),
        )

        assertTrue(result.packageEntryFound)
        assertTrue(result.relationFound)
        assertTrue(result.namespaceOk)
        assertFalse(result.fingerprintMatch)
        assertEquals(listOf(otherFingerprint), result.assetLinksFingerprints)
    }

    @Test
    fun inspectAssetLinksJson_requiresHandleAllUrlsRelation() {
        val text = """
            [
              {
                "relation": ["delegate_permission/common.get_login_creds"],
                "target": {
                  "namespace": "android_app",
                  "package_name": "com.agentic.wallet",
                  "sha256_cert_fingerprints": ["$fingerprint"]
                }
              }
            ]
        """.trimIndent()

        val result = MwaIdentityPreflight.inspectAssetLinksJson(
            text = text,
            appPackage = "com.agentic.wallet",
            expectedFingerprints = listOf(fingerprint),
        )

        assertTrue(result.packageEntryFound)
        assertFalse(result.relationFound)
        assertFalse(result.fingerprintMatch)
    }

    @Test
    fun inspectAssetLinksJson_malformedJsonReturnsParseFailure() {
        val result = MwaIdentityPreflight.inspectAssetLinksJson(
            text = "not-json",
            appPackage = "com.agentic.wallet",
            expectedFingerprints = listOf(fingerprint),
        )

        assertFalse(result.parseOk)
        assertFalse(result.packageEntryFound)
        assertFalse(result.fingerprintMatch)
        assertEquals("JSONException", result.error)
    }

    private fun assetLinksJson(packageName: String, fingerprint: String): String =
        """
            [
              {
                "relation": ["delegate_permission/common.handle_all_urls"],
                "target": {
                  "namespace": "android_app",
                  "package_name": "$packageName",
                  "sha256_cert_fingerprints": ["$fingerprint"]
                }
              }
            ]
        """.trimIndent()
}
