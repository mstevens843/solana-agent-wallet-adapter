package com.agentic.wallet.agent.provider

import org.json.JSONArray
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

    @Test
    fun extractResponsesApiTextPrefersOutputText() {
        val payload = JSONObject().put("output_text", "from responses api")
        assertEquals("from responses api", ProviderResponseParser.extractResponsesApiText(payload))
    }

    @Test
    fun extractResponsesApiTextFallsBackToOutputContentTextTree() {
        val payload = JSONObject(
            """
            {
              "output": [
                { "type": "message", "content": [
                  { "type": "output_text", "text": "alpha" },
                  { "type": "output_text", "text": "beta" }
                ] },
                { "type": "message", "content": [
                  { "type": "output_text", "text": "gamma" }
                ] }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("alpha\nbeta\ngamma", ProviderResponseParser.extractResponsesApiText(payload))
    }

    @Test
    fun extractResponsesApiTextReturnsEmptyWhenAbsent() {
        assertEquals("", ProviderResponseParser.extractResponsesApiText(JSONObject()))
    }

    @Test
    fun extractResponsesApiCitationsCollectsFromAnnotationsAndSources() {
        val payload = JSONObject(
            """
            {
              "output": [
                {
                  "type": "message",
                  "content": [
                    {
                      "type": "output_text",
                      "text": "a",
                      "annotations": [
                        { "type": "url_citation", "url": "https://example.com/a", "title": "A" },
                        { "type": "url_citation", "url": "https://example.com/b" }
                      ]
                    }
                  ]
                },
                {
                  "type": "web_search_call",
                  "action": {
                    "sources": [
                      { "url": "https://example.com/c", "title": "C" }
                    ]
                  }
                }
              ]
            }
            """.trimIndent(),
        )
        val citations = ProviderResponseParser.extractResponsesApiCitations(payload)
        assertEquals(listOf("https://example.com/a", "https://example.com/b", "https://example.com/c"), citations.map { it.url })
        assertEquals("A", citations[0].title)
    }

    @Test
    fun extractResponsesApiCitationsDedupesAndCapsAtEight() {
        val arr = JSONArray()
        for (i in 0 until 12) {
            arr.put(JSONObject().put("type", "url_citation").put("url", "https://example.com/$i"))
        }
        // Add duplicates of the first URL.
        arr.put(JSONObject().put("type", "url_citation").put("url", "https://example.com/0"))
        val payload = JSONObject().put(
            "output",
            JSONArray().put(
                JSONObject().put("type", "message").put(
                    "content",
                    JSONArray().put(JSONObject().put("type", "output_text").put("annotations", arr)),
                ),
            ),
        )
        val citations = ProviderResponseParser.extractResponsesApiCitations(payload)
        assertEquals(8, citations.size)
        // Duplicates should not appear.
        assertEquals(citations.map { it.url }.toSet().size, citations.size)
    }

    @Test
    fun extractGeminiTextJoinsParts() {
        val payload = JSONObject(
            """
            {
              "candidates": [
                {
                  "content": {
                    "parts": [
                      { "text": "alpha" },
                      { "text": "beta" }
                    ]
                  }
                }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("alpha\nbeta", ProviderResponseParser.extractGeminiText(payload))
    }

    @Test
    fun extractGeminiTextReturnsEmptyWhenAbsent() {
        assertEquals("", ProviderResponseParser.extractGeminiText(JSONObject()))
    }

    @Test
    fun extractGeminiCitationsFromGroundingChunks() {
        val payload = JSONObject(
            """
            {
              "candidates": [
                {
                  "groundingMetadata": {
                    "groundingChunks": [
                      { "web": { "uri": "https://example.com/a", "title": "A" } },
                      { "web": { "uri": "https://example.com/b" } },
                      { "web": { "uri": "https://example.com/a", "title": "dupe" } }
                    ]
                  }
                }
              ]
            }
            """.trimIndent(),
        )
        val citations = ProviderResponseParser.extractGeminiCitations(payload)
        assertEquals(listOf("https://example.com/a", "https://example.com/b"), citations.map { it.url })
        assertEquals("A", citations[0].title)
    }

    @Test
    fun extractGeminiCitationsReturnsEmptyWhenAbsent() {
        assertEquals(emptyList<Citation>(), ProviderResponseParser.extractGeminiCitations(JSONObject()))
    }

    @Test
    fun extractResponsesApiCitationsReachesDeepNestedCitations() {
        // Citations buried 4 levels deep inside non-standard keys — the walker should still
        // find them via the recursive key+array descent (cap is 10 levels of depth, 8 results).
        val payload = JSONObject(
            """
            {
              "wrapper": {
                "extras": {
                  "annotations_v2": [
                    { "type": "url_citation", "url": "https://deep.example.com/a", "title": "Deep A" }
                  ],
                  "more": {
                    "sources": [
                      { "type": "url_citation", "url": "https://deep.example.com/b" }
                    ]
                  }
                }
              }
            }
            """.trimIndent(),
        )
        val citations = ProviderResponseParser.extractResponsesApiCitations(payload)
        // Order is not part of the contract — Android's JSONObject.keys() doesn't preserve
        // insertion order. What matters: both deep citations are found, deduped by url.
        assertEquals(
            setOf("https://deep.example.com/a", "https://deep.example.com/b"),
            citations.map { it.url }.toSet(),
        )
        assertEquals("Deep A", citations.first { it.url == "https://deep.example.com/a" }.title)
    }

    @Test
    fun extractGeminiCitationsSkipsWebEntriesMissingUri() {
        val payload = JSONObject(
            """
            {
              "candidates": [
                {
                  "groundingMetadata": {
                    "groundingChunks": [
                      { "web": { "title": "no uri" } },
                      { "web": { "uri": "https://example.com/ok", "title": "OK" } },
                      { "web": {} }
                    ]
                  }
                }
              ]
            }
            """.trimIndent(),
        )
        val citations = ProviderResponseParser.extractGeminiCitations(payload)
        assertEquals(listOf("https://example.com/ok"), citations.map { it.url })
    }

    @Test
    fun extractAnthropicCitationsFromContent() {
        val payload = JSONObject(
            """
            {
              "content": [
                {
                  "type": "text",
                  "text": "hello",
                  "citations": [
                    { "type": "web_search_result_location", "url": "https://example.com/a", "title": "A", "cited_text": "snippet" }
                  ]
                },
                {
                  "type": "text",
                  "text": "world",
                  "citations": [
                    { "type": "web_search_result_location", "url": "https://example.com/b" },
                    { "type": "web_search_result_location", "url": "https://example.com/a", "title": "dupe" }
                  ]
                }
              ]
            }
            """.trimIndent(),
        )
        val citations = ProviderResponseParser.extractAnthropicCitations(payload)
        assertEquals(listOf("https://example.com/a", "https://example.com/b"), citations.map { it.url })
        assertEquals("snippet", citations[0].citedText)
    }
}
