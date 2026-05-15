package com.agentic.wallet.agent.provider

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderResponseParserTest {
    @Test
    fun extractOpenAiTextPrefersOutputText() {
        val payload = JSONObject().put("output_text", "hello world")
        assertEquals("hello world", ProviderResponseParser.extractOpenAiText(payload))
    }

    @Test
    fun extractOpenAiTextFallsBackToChoicesMessageContent() {
        val payload = JSONObject(
            """
            {
              "choices": [
                { "message": { "content": "from message" } }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("from message", ProviderResponseParser.extractOpenAiText(payload))
    }

    @Test
    fun extractOpenAiTextFallsBackToChoiceText() {
        val payload = JSONObject(
            """
            {
              "choices": [
                { "text": "direct text" }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("direct text", ProviderResponseParser.extractOpenAiText(payload))
    }

    @Test
    fun extractOpenAiTextReturnsEmptyWhenNothingMatches() {
        assertEquals("", ProviderResponseParser.extractOpenAiText(JSONObject()))
    }

    @Test
    fun extractAnthropicTextJoinsMultipleTextBlocks() {
        val payload = JSONObject(
            """
            {
              "content": [
                { "type": "text", "text": "alpha" },
                { "type": "tool_use", "id": "tool1" },
                { "type": "text", "text": "beta" }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("alpha\nbeta", ProviderResponseParser.extractAnthropicText(payload))
    }

    @Test
    fun extractAnthropicTextReturnsEmptyWhenNoTextBlocks() {
        val payload = JSONObject(
            """
            {
              "content": [
                { "type": "tool_use", "id": "tool1" }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("", ProviderResponseParser.extractAnthropicText(payload))
    }

    @Test
    fun parseModelJsonAcceptsBareJson() {
        val parsed = ProviderResponseParser.parseModelJson("""{"intent":"swap","route":"jupiter"}""")
        assertEquals("swap", parsed.optString("intent"))
        assertEquals("jupiter", parsed.optString("route"))
    }

    @Test
    fun parseModelJsonAcceptsCodeFenced() {
        val fenced = "```json\n{\"intent\":\"swap\"}\n```"
        val parsed = ProviderResponseParser.parseModelJson(fenced)
        assertEquals("swap", parsed.optString("intent"))
    }

    @Test
    fun parseModelJsonAcceptsEmbeddedJson() {
        val text = """Here is the plan:
            {"intent":"transfer SOL","route":"system","risk":"low","approval":"once","safeguards":["confirm recipient"]}
            Let me know.
        """.trimIndent()
        val parsed = ProviderResponseParser.parseModelJson(text)
        assertEquals("transfer SOL", parsed.optString("intent"))
        assertTrue(parsed.optJSONArray("safeguards")?.length() ?: 0 > 0)
    }

    @Test
    fun parseModelJsonThrowsOnNonJson() {
        val ex = assertThrows(ProviderHttpException::class.java) {
            ProviderResponseParser.parseModelJson("not json at all")
        }
        assertEquals(ProviderErrorCodes.INVALID_RESPONSE, ex.code)
    }

    @Test
    fun parseModelJsonThrowsOnEmpty() {
        val ex = assertThrows(ProviderHttpException::class.java) {
            ProviderResponseParser.parseModelJson("   ")
        }
        assertEquals(ProviderErrorCodes.INVALID_RESPONSE, ex.code)
    }

    @Test
    fun extractOpenAiTextRejectsNonStringOutputText() {
        // Strict string check — non-string output_text falls through to choices[]
        val payload = JSONObject(
            """
            {
              "output_text": 42,
              "choices": [
                { "message": { "content": "fallback" } }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("fallback", ProviderResponseParser.extractOpenAiText(payload))
    }

    @Test
    fun extractAnthropicTextWorksWithoutTypeField() {
        // Mirror planner.ts: extract text from every content entry regardless of type field
        val payload = JSONObject(
            """
            {
              "content": [
                { "text": "alpha" },
                { "text": "beta" }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("alpha\nbeta", ProviderResponseParser.extractAnthropicText(payload))
    }

    @Test
    fun extractAnthropicTextSkipsNonStringText() {
        val payload = JSONObject(
            """
            {
              "content": [
                { "type": "text", "text": 42 },
                { "type": "text", "text": "ok" }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("ok", ProviderResponseParser.extractAnthropicText(payload))
    }
}
