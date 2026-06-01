package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.prompts.DeviceAgentMessageAssembler
import com.agentic.wallet.agent.prompts.DeviceAgentSystemPrompts
import com.agentic.wallet.agent.runtime.RuntimeConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

class GeminiNativeProviderTest {
    private fun config(
        model: String = "gemini-2.5-pro",
        baseUrl: String = "https://generativelanguage.googleapis.com/v1beta/openai",
    ): RuntimeConfig = RuntimeConfig(
        provider = "gemini",
        apiFormat = "openai-compatible",
        model = model,
        baseUrl = baseUrl,
        apiKey = "AIzaTEST-ABCDEFGHIJKLMNOP",
        walletAddress = null,
    )

    private fun geminiTextResponse(text: String): String =
        """{"candidates":[{"content":{"parts":[{"text":"$text"}]}}]}"""

    @Test
    fun generatePlanPostsToGenerateContentWithSystemInstructionAndResponseSchema() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                geminiTextResponse("{\\\"intent\\\":\\\"swap\\\",\\\"route\\\":\\\"jupiter\\\",\\\"risk\\\":\\\"low\\\",\\\"approval\\\":\\\"once\\\",\\\"safeguards\\\":[\\\"check slippage\\\"]}"),
            )
        }
        val provider = GeminiNativeProvider(config(), http)
        val result = provider.generatePlan(JSONObject().put("userPrompt", "swap 1 SOL for USDC"))

        assertEquals("swap", result.optString("intent"))
        val call = http.calls.single()
        // /openai stripped from preset, model + :generateContent appended.
        assertEquals(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
            call.url,
        )
        assertEquals("AIzaTEST-ABCDEFGHIJKLMNOP", call.headers["x-goog-api-key"])
        assertNull(call.headers["Authorization"])

        val body = JSONObject(call.body)
        val systemInstruction = body.optJSONObject("systemInstruction")!!
        assertEquals(
            DeviceAgentSystemPrompts.PLAN,
            systemInstruction.optJSONArray("parts")?.optJSONObject(0)?.optString("text"),
        )
        val contents = body.optJSONArray("contents")!!
        assertEquals(1, contents.length())
        assertEquals("user", contents.getJSONObject(0).optString("role"))
        assertEquals(
            DeviceAgentMessageAssembler.buildPlanMessages(JSONObject().put("userPrompt", "swap 1 SOL for USDC")).userContent,
            contents.getJSONObject(0).optJSONArray("parts")?.optJSONObject(0)?.optString("text"),
        )

        val generationConfig = body.optJSONObject("generationConfig")!!
        assertEquals(0.2, generationConfig.optDouble("temperature"), 0.0001)
        assertEquals(1024, generationConfig.optInt("maxOutputTokens"))
        assertEquals("application/json", generationConfig.optString("responseMimeType"))
        val responseSchema = generationConfig.optJSONObject("responseSchema")!!
        assertEquals("object", responseSchema.optString("type"))
        assertTrue(responseSchema.optJSONArray("required")!!.toString().contains("safeguards"))
        assertFalse(body.has("tools"))
    }

    @Test
    fun generatePlanIsIdempotentWithNativeBaseUrl() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, geminiTextResponse("{\\\"intent\\\":\\\"x\\\"}"))
        }
        val provider = GeminiNativeProvider(
            config(baseUrl = "https://generativelanguage.googleapis.com/v1beta"),
            http,
        )
        provider.generatePlan(JSONObject().put("userPrompt", "hi"))
        assertEquals(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
            http.calls.single().url,
        )
    }

    @Test
    fun generatePlanAppendsV1betaWhenBareHost() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, geminiTextResponse("{\\\"intent\\\":\\\"x\\\"}"))
        }
        val provider = GeminiNativeProvider(
            config(model = "gemini-2.5-flash", baseUrl = "https://example-gemini-proxy.dev"),
            http,
        )
        provider.generatePlan(JSONObject().put("userPrompt", "hi"))
        assertEquals(
            "https://example-gemini-proxy.dev/v1beta/models/gemini-2.5-flash:generateContent",
            http.calls.single().url,
        )
    }

    @Test
    fun reviewPlanRunsTwoPassResearchWithGoogleSearchAndNoJsonResponseConfig() = runBlocking {
        val http = FakeHttpExecutor().apply {
            // Pass 1: grounded research returns text + groundingMetadata.
            queueResponse(
                200,
                """{"candidates":[{"content":{"parts":[{"text":"Helium Mobile cheapest plan is Air at $15/month."}]},"groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://www.heliummobile.com/plans","title":"Plans — Helium Mobile"}}]}}]}""",
            )
            // Pass 2: structured review.
            queueResponse(
                200,
                geminiTextResponse("{\\\"decision\\\":\\\"approve\\\",\\\"reason\\\":\\\"Air plan is $15.\\\",\\\"summary\\\":\\\"Approved\\\",\\\"evidence\\\":{}}"),
            )
        }
        val fixedClock = Clock.fixed(Instant.parse("2026-05-18T00:00:00Z"), ZoneOffset.UTC)
        val provider = GeminiNativeProvider(config(), http, fixedClock)
        val result = provider.reviewPlan(
            JSONObject()
                .put("instruction", "check helium mobile. lowest monthly plan. if less than $20. approve.")
                .put("plan", JSONObject().put("intent", "swap"))
                .put(
                    "research",
                    JSONObject().put("needed", true).put("mode", "auto_current_facts"),
                ),
        )

        assertEquals("approve", result.optString("decision"))
        val evidence = result.optJSONObject("evidence")!!
        assertEquals("checked", evidence.optJSONObject("research")!!.optString("status"))
        assertTrue(evidence.optJSONArray("findings")!!.toString().contains("Current research"))
        assertTrue(evidence.optJSONArray("sources")!!.toString().contains("heliummobile.com"))
        assertEquals(2, http.calls.size)

        val researchBody = JSONObject(http.calls[0].body)
        val tools = researchBody.optJSONArray("tools")!!
        assertEquals(1, tools.length())
        assertTrue(tools.getJSONObject(0).has("google_search"))
        val researchGen = researchBody.optJSONObject("generationConfig")!!
        assertFalse(researchGen.has("responseMimeType"))
        assertFalse(researchGen.has("responseSchema"))
        assertEquals(1800, researchGen.optInt("maxOutputTokens"))

        val reviewBody = JSONObject(http.calls[1].body)
        assertFalse(reviewBody.has("tools"))
        val reviewGen = reviewBody.optJSONObject("generationConfig")!!
        assertEquals("application/json", reviewGen.optString("responseMimeType"))
        assertEquals(1800, reviewGen.optInt("maxOutputTokens"))
        val responseSchema = reviewGen.optJSONObject("responseSchema")!!
        assertEquals("object", responseSchema.optString("type"))
        assertTrue(responseSchema.optJSONObject("properties")!!.has("evidenceFactIds"))
        assertTrue(responseSchema.optJSONObject("properties")!!.has("blockingFactIds"))
        assertTrue(responseSchema.optJSONObject("properties")!!.has("missingFactIds"))
        assertTrue(responseSchema.optJSONObject("properties")!!.has("confidence"))
        val reviewInput =
            reviewBody.optJSONArray("contents")?.optJSONObject(0)?.optJSONArray("parts")?.optJSONObject(0)?.optString("text")
                .orEmpty()
        assertTrue(reviewInput.contains("researchEvidence"))
        assertTrue(reviewInput.contains("heliummobile.com"))
        assertTrue(
            "input should contain clock-fixed checkedAt; got: $reviewInput",
            reviewInput.contains("\"checkedAt\":\"2026-05-18T00:00:00Z\""),
        )
    }

    @Test
    fun reviewPlanFallsBackToSinglePassWhenResearchFails() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueFailure(RuntimeException("research pass network blip"))
            queueResponse(
                200,
                geminiTextResponse("{\\\"decision\\\":\\\"needs_input\\\",\\\"reason\\\":\\\"Cannot confirm.\\\",\\\"summary\\\":\\\"Needs input\\\",\\\"evidence\\\":{}}"),
            )
        }
        val provider = GeminiNativeProvider(config(), http)
        val result = provider.reviewPlan(
            JSONObject()
                .put("plan", JSONObject().put("intent", "swap"))
                .put(
                    "research",
                    JSONObject().put("needed", true).put("mode", "auto_current_facts"),
                ),
        )
        assertEquals("needs_input", result.optString("decision"))
        assertEquals(2, http.calls.size)
    }

    @Test
    fun singlePassReviewKeepsResponseMimeTypeAndOmitsTools() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                geminiTextResponse("{\\\"decision\\\":\\\"approve\\\",\\\"reason\\\":\\\"ok\\\",\\\"summary\\\":\\\"go\\\",\\\"evidence\\\":{}}"),
            )
        }
        val provider = GeminiNativeProvider(config(), http)
        val payload = JSONObject()
            .put("plan", JSONObject().put("intent", "swap"))
            .put(
                "research",
                JSONObject()
                    .put("needed", false)
                    .put("mode", "not_required")
                    .put("currentDate", "2026-05-17T00:00:00Z")
                    .put("maxSearches", 3),
            )
        provider.reviewPlan(payload)

        val body = JSONObject(http.calls.single().body)
        assertFalse(body.has("tools"))
        val generationConfig = body.optJSONObject("generationConfig")!!
        assertEquals("application/json", generationConfig.optString("responseMimeType"))
        assertTrue(generationConfig.optJSONObject("responseSchema")!!.optJSONObject("properties")!!.has("evidenceFactIds"))
        val input = body.optJSONArray("contents")?.optJSONObject(0)?.optJSONArray("parts")?.optJSONObject(0)?.optString("text")
        assertEquals(DeviceAgentMessageAssembler.buildReviewMessages(payload).userContent, input)
    }

    @Test
    fun askOmitsResponseMimeTypeAndUsesAskTemperature() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, geminiTextResponse("It will swap SOL for USDC via Jupiter."))
        }
        val provider = GeminiNativeProvider(config(), http)
        val result = provider.ask(JSONObject().put("question", "what happens?"))

        assertTrue(result.optString("output_text").startsWith("It will swap"))
        val gen = JSONObject(http.calls.single().body).optJSONObject("generationConfig")!!
        assertFalse(gen.has("responseMimeType"))
        assertFalse(gen.has("responseSchema"))
        assertEquals(0.3, gen.optDouble("temperature"), 0.0001)
        assertEquals(800, gen.optInt("maxOutputTokens"))
    }

    @Test
    fun askAttachesGoogleSearchWhenResearchRequested() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, geminiTextResponse("Current Helium cheapest plan is $15."))
        }
        val provider = GeminiNativeProvider(config(), http)
        provider.ask(
            JSONObject()
                .put("question", "what is the current Helium plan?")
                .put(
                    "research",
                    JSONObject().put("needed", true).put("mode", "auto_current_facts"),
                ),
        )

        val body = JSONObject(http.calls.single().body)
        val tools = body.optJSONArray("tools")!!
        assertTrue(tools.getJSONObject(0).has("google_search"))
        val generationConfig = body.optJSONObject("generationConfig")!!
        assertFalse(generationConfig.has("responseMimeType"))
        assertFalse(generationConfig.has("responseSchema"))
    }

    @Test
    fun askThrowsInvalidResponseOnBlankText() {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, geminiTextResponse(""))
        }
        val provider = GeminiNativeProvider(config(), http)
        val ex = try {
            runBlocking { provider.ask(JSONObject().put("question", "what happens?")) }
            null
        } catch (e: ProviderHttpException) {
            e
        }
        assertNotEquals(null, ex)
        assertEquals(ProviderErrorCodes.INVALID_RESPONSE, ex!!.code)
    }

    @Test
    fun cancellationDuringResearchPassPropagates() {
        val http = FakeHttpExecutor().apply {
            queueFailure(CancellationException("user backed out"))
        }
        val provider = GeminiNativeProvider(config(), http)
        val ex = runCatching {
            runBlocking {
                provider.reviewPlan(
                    JSONObject()
                        .put("plan", JSONObject().put("intent", "swap"))
                        .put(
                            "research",
                            JSONObject().put("needed", true).put("mode", "auto_current_facts"),
                        ),
                )
            }
        }.exceptionOrNull()
        assertTrue("Expected CancellationException, got $ex", ex is CancellationException)
        assertEquals(1, http.calls.size)
    }

    @Test
    fun authErrorMapsTo403Code() {
        val http = FakeHttpExecutor().apply {
            queueResponse(403, """{"error":{"message":"key not allowed"}}""")
        }
        val provider = GeminiNativeProvider(config(), http)
        val ex = try {
            runBlocking { provider.generatePlan(JSONObject().put("userPrompt", "hi")) }
            null
        } catch (e: ProviderHttpException) {
            e
        }
        assertNotEquals(null, ex)
        assertEquals(ProviderErrorCodes.AUTH, ex!!.code)
    }
}
