package com.agentic.wallet.agent.provider

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderHttpTest {
    @Test
    fun mapsHttpStatus() {
        assertNull(ProviderHttp.mapHttpStatusToErrorCode(200))
        assertEquals(ProviderErrorCodes.AUTH, ProviderHttp.mapHttpStatusToErrorCode(401))
        assertEquals(ProviderErrorCodes.AUTH, ProviderHttp.mapHttpStatusToErrorCode(403))
        assertEquals(ProviderErrorCodes.RATE_LIMITED, ProviderHttp.mapHttpStatusToErrorCode(429))
        assertEquals(ProviderErrorCodes.TIMEOUT, ProviderHttp.mapHttpStatusToErrorCode(408))
        assertEquals(ProviderErrorCodes.TIMEOUT, ProviderHttp.mapHttpStatusToErrorCode(504))
        assertEquals(ProviderErrorCodes.UPSTREAM, ProviderHttp.mapHttpStatusToErrorCode(500))
        assertEquals(ProviderErrorCodes.UPSTREAM, ProviderHttp.mapHttpStatusToErrorCode(503))
        assertEquals(ProviderErrorCodes.INVALID_RESPONSE, ProviderHttp.mapHttpStatusToErrorCode(418))
    }

    @Test
    fun normalizeBaseUrlAppendsV1ForOpenAi() {
        assertEquals("https://api.openai.com/v1", ProviderHttp.normalizeBaseUrl("https://api.openai.com", "openai-compatible"))
        assertEquals("https://api.openai.com/v1", ProviderHttp.normalizeBaseUrl("https://api.openai.com/", "openai-compatible"))
        assertEquals("https://api.openai.com/v1", ProviderHttp.normalizeBaseUrl("https://api.openai.com/v1", "openai-compatible"))
        assertEquals("https://generativelanguage.googleapis.com/v1beta/openai", ProviderHttp.normalizeBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai", "openai-compatible"))
    }

    @Test
    fun normalizeBaseUrlAppendsV1ForAnthropic() {
        assertEquals("https://api.anthropic.com/v1", ProviderHttp.normalizeBaseUrl("https://api.anthropic.com", "anthropic"))
        assertEquals("https://api.anthropic.com/v1", ProviderHttp.normalizeBaseUrl("https://api.anthropic.com/", "anthropic"))
        assertEquals("https://api.anthropic.com/v2", ProviderHttp.normalizeBaseUrl("https://api.anthropic.com/v2", "anthropic"))
    }

    @Test
    fun normalizeBaseUrlFallsBackToPresetWhenBlank() {
        assertEquals("https://api.openai.com/v1", ProviderHttp.normalizeBaseUrl("", "openai-compatible"))
        assertEquals("https://api.openai.com/v1", ProviderHttp.normalizeBaseUrl(null, "openai-compatible"))
        assertEquals("https://api.anthropic.com/v1", ProviderHttp.normalizeBaseUrl("", "anthropic"))
    }

    @Test
    fun isDefaultTemperatureOnlyModelDetectsGpt5AndOSeries() {
        assertTrue(ProviderHttp.isDefaultTemperatureOnlyModel("gpt-5"))
        assertTrue(ProviderHttp.isDefaultTemperatureOnlyModel("gpt-5-turbo"))
        assertTrue(ProviderHttp.isDefaultTemperatureOnlyModel("provider/gpt-5"))
        assertTrue(ProviderHttp.isDefaultTemperatureOnlyModel("o1-preview"))
        assertTrue(ProviderHttp.isDefaultTemperatureOnlyModel("o3-mini"))
        assertTrue(ProviderHttp.isDefaultTemperatureOnlyModel("provider/o1"))
        assertTrue(ProviderHttp.isDefaultTemperatureOnlyModel("provider/o4-mini"))
        assertFalse(ProviderHttp.isDefaultTemperatureOnlyModel("gpt-4o"))
        assertFalse(ProviderHttp.isDefaultTemperatureOnlyModel("claude-opus-4-5"))
        assertFalse(ProviderHttp.isDefaultTemperatureOnlyModel("gemini-1.5-pro"))
        assertFalse(ProviderHttp.isDefaultTemperatureOnlyModel(""))
    }

    @Test
    fun assertApiKeyHeaderSafeAcceptsAscii() {
        ProviderHttp.assertApiKeyHeaderSafe("sk-ABCDEF1234567890")
        ProviderHttp.assertApiKeyHeaderSafe("xoxp-1234567890abcdef")
    }

    @Test
    fun assertApiKeyHeaderSafeRejectsControlChars() {
        val ex = assertThrows(ProviderHttpException::class.java) {
            ProviderHttp.assertApiKeyHeaderSafe("sk-\nABCDEF")
        }
        assertEquals(ProviderErrorCodes.INVALID_CONFIG, ex.code)
    }

    @Test
    fun assertApiKeyHeaderSafeRejectsNonAscii() {
        val ex = assertThrows(ProviderHttpException::class.java) {
            ProviderHttp.assertApiKeyHeaderSafe("sk-ABCéDEF")
        }
        assertEquals(ProviderErrorCodes.INVALID_CONFIG, ex.code)
    }

    @Test
    fun assertApiKeyHeaderSafeRejectsEmpty() {
        val ex = assertThrows(ProviderHttpException::class.java) {
            ProviderHttp.assertApiKeyHeaderSafe("")
        }
        assertEquals(ProviderErrorCodes.INVALID_CONFIG, ex.code)
        assertTrue(
            "Empty-key message should be clear, got: ${ex.message}",
            ex.message.contains("empty", ignoreCase = true),
        )
    }

    @Test
    fun composeErrorMessageWithJsonErrorMessage() {
        val composed = ProviderHttp.composeErrorMessage(
            401,
            """{"error":{"message":"key invalid"}}""",
        )
        assertTrue("Should start with upstream message: $composed", composed.startsWith("key invalid."))
        assertTrue("Should append 401 explanation: $composed", composed.contains("belongs to this provider"))
    }

    @Test
    fun composeErrorMessageWithRawErrorString() {
        val composed = ProviderHttp.composeErrorMessage(
            429,
            """{"error":"limit reached"}""",
        )
        assertTrue("Should include upstream msg: $composed", composed.contains("limit reached"))
        assertTrue("Should append 429 explanation: $composed", composed.contains("too many requests"))
    }

    @Test
    fun composeErrorMessageWithBlankBody() {
        val composed = ProviderHttp.composeErrorMessage(503, "")
        assertTrue(
            "Should fall back to HTTP message: $composed",
            composed.startsWith("AI provider returned HTTP 503."),
        )
        assertTrue("Should append 503 explanation: $composed", composed.contains("temporarily unavailable"))
    }

    @Test
    fun composeErrorMessageUnknownStatusOmitsExplanation() {
        val composed = ProviderHttp.composeErrorMessage(200, """{"error":{"message":"weird"}}""")
        // 200 has no explanation; output is just the base message, no trailing whitespace.
        assertEquals("weird", composed)
    }

    @Test
    fun composeErrorMessageNoDoublePeriods() {
        val composed = ProviderHttp.composeErrorMessage(
            429,
            """{"error":{"message":"already a sentence."}}""",
        )
        assertFalse("Must not double-period: $composed", composed.contains(".."))
    }

    @Test
    fun composeErrorMessageAddsSeparatorWhenBaseHasNoTerminal() {
        val composed = ProviderHttp.composeErrorMessage(
            500,
            """{"error":{"message":"backend exploded"}}""",
        )
        assertTrue("Should insert a period: $composed", composed.startsWith("backend exploded. "))
    }

    @Test
    fun composeErrorMessageHandlesMalformedBody() {
        val composed = ProviderHttp.composeErrorMessage(500, "not even json")
        assertTrue(composed.startsWith("AI provider returned HTTP 500."))
    }
}
