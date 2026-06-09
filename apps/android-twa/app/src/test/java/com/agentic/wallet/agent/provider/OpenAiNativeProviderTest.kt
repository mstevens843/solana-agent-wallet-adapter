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
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

class OpenAiNativeProviderTest {
    private fun config(model: String = "gpt-5"): RuntimeConfig = RuntimeConfig(
        provider = "openai",
        apiFormat = "openai-compatible",
        model = model,
        baseUrl = "https://api.openai.com",
        apiKey = "sk-test-ABCDEFGHIJKLMNOP",
        walletAddress = null,
    )

    @Test
    fun generatePlanPostsToResponsesEndpointWithReasoningForGpt5() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"output_text":"{\"intent\":\"swap\",\"route\":\"jupiter\",\"risk\":\"low\",\"approval\":\"once\",\"safeguards\":[\"check slippage\"]}"}""",
            )
        }
        val provider = OpenAiNativeProvider(config(), http)
        val payload = JSONObject().put("userPrompt", "swap 1 SOL for USDC")
        val result = provider.generatePlan(payload)

        assertEquals("swap", result.optString("intent"))
        val call = http.calls.single()
        assertEquals("https://api.openai.com/v1/responses", call.url)
        assertEquals("Bearer sk-test-ABCDEFGHIJKLMNOP", call.headers["Authorization"])

        val body = JSONObject(call.body)
        assertEquals("gpt-5", body.optString("model"))
        assertEquals(DeviceAgentSystemPrompts.PLAN, body.optString("instructions"))
        // gpt-5 is a reasoning model, so the plan budget is raised to the reasoning floor (4096)
        // so reasoning tokens don't consume the whole budget and leave empty content.
        assertEquals(4096, body.optInt("max_output_tokens"))
        assertEquals(false, body.optBoolean("store"))

        val textConfig = body.optJSONObject("text")!!
        assertEquals("low", textConfig.optString("verbosity"))
        val format = textConfig.optJSONObject("format")!!
        assertEquals("json_schema", format.optString("type"))
        assertEquals("agentic_device_plan", format.optString("name"))
        assertEquals(true, format.optBoolean("strict"))

        // Reasoning effort for gpt-5; no temperature.
        assertEquals("low", body.optJSONObject("reasoning")?.optString("effort"))
        assertFalse(body.has("temperature"))
        assertFalse(body.has("tools"))
        assertFalse(body.has("max_tokens"))
        assertFalse(body.has("max_completion_tokens"))
    }

    @Test
    fun generatePlanSendsTemperatureForNonReasoningModel() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"output_text":"{\"intent\":\"x\"}"}""")
        }
        val provider = OpenAiNativeProvider(config(model = "gpt-4.1"), http)
        provider.generatePlan(JSONObject().put("userPrompt", "hi"))

        val body = JSONObject(http.calls.single().body)
        assertEquals(0.2, body.optDouble("temperature"), 0.0001)
        assertFalse(body.has("reasoning"))
    }

    @Test
    fun generatePlanFallsBackToWalkedOutputContentText() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"output":[{"type":"message","content":[{"type":"output_text","text":"{\"intent\":\"swap\"}"}]}]}""",
            )
        }
        val provider = OpenAiNativeProvider(config(), http)
        val result = provider.generatePlan(JSONObject().put("userPrompt", "hi"))
        assertEquals("swap", result.optString("intent"))
    }

    @Test
    fun reviewPlanRunsTwoPassResearchWhenRequested() = runBlocking {
        val http = FakeHttpExecutor().apply {
            // Pass 1: research with citations.
            queueResponse(
                200,
                """{"output_text":"Helium Mobile offers Zero ($0/mo) and Air ($15/mo).","output":[{"type":"message","content":[{"type":"output_text","text":"Helium Mobile offers Zero ($0/mo) and Air ($15/mo).","annotations":[{"type":"url_citation","url":"https://www.heliummobile.com/plans","title":"Plans"}]}]}]}""",
            )
            // Pass 2: structured review approves.
            queueResponse(
                200,
                """{"output_text":"{\"decision\":\"approve\",\"reason\":\"Air plan is $15.\",\"summary\":\"Approved\",\"evidence\":{}}"}""",
            )
        }
        val fixedClock = Clock.fixed(Instant.parse("2026-05-18T00:00:00Z"), ZoneOffset.UTC)
        val provider = OpenAiNativeProvider(config(), http, fixedClock)
        val result = provider.reviewPlan(
            JSONObject()
                .put("instruction", "check helium mobile. lowest monthly plan. if less than $20. approve.")
                .put("plan", JSONObject().put("intent", "swap"))
                .put(
                    "research",
                    JSONObject()
                        .put("needed", true)
                        .put("mode", "auto_current_facts")
                        .put("currentDate", "2026-05-17T00:00:00Z")
                        .put("maxSearches", 3),
                ),
        )

        assertEquals("approve", result.optString("decision"))
        val evidence = result.optJSONObject("evidence")!!
        assertEquals("checked", evidence.optJSONObject("research")!!.optString("status"))
        assertTrue(evidence.optJSONArray("findings")!!.toString().contains("Current research"))
        assertTrue(evidence.optJSONArray("sources")!!.toString().contains("heliummobile.com"))
        assertEquals(2, http.calls.size)

        // Research pass: tools + tool_choice + include set, no text.format.
        val researchBody = JSONObject(http.calls[0].body)
        val tools = researchBody.optJSONArray("tools")!!
        assertEquals(1, tools.length())
        assertEquals("web_search_preview", tools.getJSONObject(0).optString("type"))
        assertEquals("auto", researchBody.optString("tool_choice"))
        assertEquals(
            "web_search_call.action.sources",
            researchBody.optJSONArray("include")?.optString(0),
        )
        assertEquals(4096, researchBody.optInt("max_output_tokens")) // gpt-5 reasoning floor (was 1800)
        assertFalse(researchBody.has("text"))

        // Review pass: no tools; text.format.json_schema; verbosity=medium; injected
        // researchEvidence in the input.
        val reviewBody = JSONObject(http.calls[1].body)
        assertFalse(reviewBody.has("tools"))
        assertEquals(4096, reviewBody.optInt("max_output_tokens")) // gpt-5 reasoning floor (was 1800)
        val reviewText = reviewBody.optJSONObject("text")!!
        assertEquals("medium", reviewText.optString("verbosity"))
        val reviewFormat = reviewText.optJSONObject("format")!!
        assertEquals("json_schema", reviewFormat.optString("type"))
        assertEquals("agentic_device_review", reviewFormat.optString("name"))
        assertEquals(false, reviewFormat.optBoolean("strict"))
        val reviewSchemaProps = reviewFormat.optJSONObject("schema")!!.optJSONObject("properties")!!
        val evidenceProps = reviewSchemaProps.optJSONObject("evidence")!!.optJSONObject("properties")!!
        assertTrue(evidenceProps.has("findings"))
        assertTrue(evidenceProps.has("sources"))
        assertTrue(evidenceProps.has("research"))
        assertTrue(reviewSchemaProps.has("evidenceFactIds"))
        assertTrue(reviewSchemaProps.has("blockingFactIds"))
        assertTrue(reviewSchemaProps.has("missingFactIds"))
        assertTrue(reviewSchemaProps.has("confidence"))
        val reviewInput = reviewBody.optString("input")
        assertTrue("input should contain researchEvidence", reviewInput.contains("researchEvidence"))
        assertTrue("input should contain official source", reviewInput.contains("heliummobile.com"))
        // Fixed clock pins the timestamp deterministically.
        assertTrue(
            "input should contain clock-fixed checkedAt; got: $reviewInput",
            reviewInput.contains("\"checkedAt\":\"2026-05-18T00:00:00Z\""),
        )
    }

    @Test
    fun reviewPlanFallsBackToSinglePassWhenResearchPassFails() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueFailure(RuntimeException("research pass network blip"))
            queueResponse(
                200,
                """{"output_text":"{\"decision\":\"needs_input\",\"reason\":\"Cannot confirm.\",\"summary\":\"Needs input\",\"evidence\":{}}"}""",
            )
        }
        val provider = OpenAiNativeProvider(config(), http)
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
    fun singlePassReviewDoesNotAttachTools() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"output_text":"{\"decision\":\"approve\",\"reason\":\"ok\",\"summary\":\"go\",\"evidence\":{}}"}""",
            )
        }
        val provider = OpenAiNativeProvider(config(), http)
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
        assertEquals(4096, body.optInt("max_output_tokens")) // gpt-5 reasoning floor (was 1800)
        val reviewText = body.optJSONObject("text")!!
        assertEquals("medium", reviewText.optString("verbosity"))
        val format = reviewText.optJSONObject("format")!!
        assertEquals("json_schema", format.optString("type"))
        assertEquals("agentic_device_review", format.optString("name"))
        val schemaProps = format.optJSONObject("schema")!!.optJSONObject("properties")!!
        val evidenceProps = schemaProps.optJSONObject("evidence")!!.optJSONObject("properties")!!
        assertTrue(evidenceProps.has("findings"))
        assertTrue(evidenceProps.has("sources"))
        assertTrue(evidenceProps.has("research"))
        assertTrue(schemaProps.has("evidenceFactIds"))
        assertTrue(schemaProps.has("blockingFactIds"))
        assertTrue(schemaProps.has("missingFactIds"))
        assertTrue(schemaProps.has("confidence"))
        assertEquals(DeviceAgentSystemPrompts.REVIEW, body.optString("instructions"))
        assertEquals(
            DeviceAgentMessageAssembler.buildReviewMessages(payload).userContent,
            body.optString("input"),
        )
    }

    @Test
    fun blogCitationsAreFilteredOutOfReviewInput() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"output_text":"Helium Mobile cheapest plan is Air at $15/month.","output":[{"type":"message","content":[{"type":"output_text","text":"Helium Mobile cheapest plan is Air at $15/month.","annotations":[{"type":"url_citation","url":"https://blog.heliummobile.com/break-free","title":"Break Free"},{"type":"url_citation","url":"https://www.heliummobile.com/plans","title":"Plans"}]}]}]}""",
            )
            queueResponse(
                200,
                """{"output_text":"{\"decision\":\"approve\",\"reason\":\"Air plan is $15.\",\"summary\":\"Approved\",\"evidence\":{}}"}""",
            )
        }
        val provider = OpenAiNativeProvider(config(), http)
        provider.reviewPlan(
            JSONObject()
                .put("instruction", "check helium mobile. lowest monthly plan. if less than $20. approve.")
                .put("plan", JSONObject().put("intent", "swap"))
                .put(
                    "research",
                    JSONObject().put("needed", true).put("mode", "auto_current_facts"),
                ),
        )

        val reviewBody = JSONObject(http.calls[1].body)
        val input = reviewBody.optString("input")
        assertTrue(input.contains("heliummobile.com/plans"))
        assertFalse(input.contains("blog.heliummobile.com"))
    }

    @Test
    fun blogOnlyCitationsSuppressSummaryForPricingQuestion() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"output_text":"Helium Mobile offers the Zero Plan at $0/month.","output":[{"type":"message","content":[{"type":"output_text","text":"Helium Mobile offers the Zero Plan at $0/month.","annotations":[{"type":"url_citation","url":"https://blog.heliummobile.com/zero-plan","title":"Zero Plan"}]}]}]}""",
            )
            queueResponse(
                200,
                """{"output_text":"{\"decision\":\"needs_input\",\"reason\":\"Not verified.\",\"summary\":\"Needs input\",\"evidence\":{}}"}""",
            )
        }
        val provider = OpenAiNativeProvider(config(), http)
        provider.reviewPlan(
            JSONObject()
                .put("instruction", "check helium mobile. lowest monthly plan. if less than $20. approve.")
                .put("plan", JSONObject().put("intent", "swap"))
                .put(
                    "research",
                    JSONObject().put("needed", true).put("mode", "auto_current_facts"),
                ),
        )

        val reviewBody = JSONObject(http.calls[1].body)
        val input = reviewBody.optString("input")
        assertTrue(input.contains("Current pricing could not be verified"))
        assertFalse(input.contains("Zero Plan"))
        assertFalse(input.contains("blog.heliummobile.com"))
    }

    @Test
    fun askOmitsFormatAndUsesAskTemperature() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"output_text":"It will swap SOL for USDC via Jupiter."}""")
        }
        val provider = OpenAiNativeProvider(config(model = "gpt-4.1"), http)
        val result = provider.ask(JSONObject().put("question", "what happens?"))

        assertTrue(result.optString("output_text").startsWith("It will swap"))
        val body = JSONObject(http.calls.single().body)
        assertFalse(body.has("text"))
        assertEquals(0.3, body.optDouble("temperature"), 0.0001)
        assertEquals(800, body.optInt("max_output_tokens"))
    }

    @Test
    fun askAttachesWebSearchToolWhenResearchRequested() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"output_text":"Current cheapest plan is $15."}""")
        }
        val provider = OpenAiNativeProvider(config(), http)
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
        assertEquals(1, tools.length())
        assertEquals("web_search_preview", tools.getJSONObject(0).optString("type"))
    }

    @Test
    fun askThrowsInvalidResponseOnBlankOutputText() {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"output_text":""}""")
        }
        val provider = OpenAiNativeProvider(config(), http)
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
    fun authErrorMapsTo401Code() {
        val http = FakeHttpExecutor().apply {
            queueResponse(401, """{"error":{"message":"invalid key"}}""")
        }
        val provider = OpenAiNativeProvider(config(), http)
        val ex = try {
            runBlocking { provider.generatePlan(JSONObject().put("userPrompt", "hi")) }
            null
        } catch (e: ProviderHttpException) {
            e
        }
        assertNotEquals(null, ex)
        assertEquals(ProviderErrorCodes.AUTH, ex!!.code)
    }

    @Test
    fun cancellationDuringResearchPassPropagates() {
        val http = FakeHttpExecutor().apply {
            // Research pass: queue a CancellationException; runResearchPass must rethrow it
            // (NOT swallow it into the catch-all that returns the original payload).
            queueFailure(CancellationException("user backed out"))
            // If the implementation incorrectly swallowed the cancellation, we'd next see
            // the review pass call this and need a queued response. Leave the queue empty
            // so a swallowed cancellation would fail with "no queued response" instead.
        }
        val provider = OpenAiNativeProvider(config(), http)
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
        // The review pass must NOT have run.
        assertEquals(1, http.calls.size)
    }

    @Test
    fun malformedBodyMapsToInvalidResponse() {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, "{not even json")
        }
        val provider = OpenAiNativeProvider(config(), http)
        val ex = try {
            runBlocking { provider.generatePlan(JSONObject().put("userPrompt", "hi")) }
            null
        } catch (e: ProviderHttpException) {
            e
        }
        assertNotEquals(null, ex)
        assertEquals(ProviderErrorCodes.INVALID_RESPONSE, ex!!.code)
    }
}
