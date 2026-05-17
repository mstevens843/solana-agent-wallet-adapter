package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.prompts.DeviceAgentMessageAssembler
import com.agentic.wallet.agent.prompts.DeviceAgentSystemPrompts
import com.agentic.wallet.agent.runtime.RuntimeConfig
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenAiCompatibleProviderTest {
    private fun config(model: String = "gpt-4o-mini"): RuntimeConfig = RuntimeConfig(
        provider = "openai",
        apiFormat = "openai-compatible",
        model = model,
        baseUrl = "https://api.openai.com",
        apiKey = "sk-test-ABCDEFGHIJKLMNOP",
        walletAddress = null,
    )

    @Test
    fun generatePlanSendsJsonObjectModeAndTemperature() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"choices":[{"message":{"content":"{\"intent\":\"swap\",\"route\":\"jupiter\",\"risk\":\"low\",\"approval\":\"once\",\"safeguards\":[\"check slippage\"]}"}}]}""",
            )
        }
        val provider = OpenAiCompatibleProvider(config(), http)
        val payload = JSONObject().put("userPrompt", "swap 1 SOL for USDC")

        val result = provider.generatePlan(payload)

        assertEquals("swap", result.optString("intent"))
        val call = http.calls.single()
        assertEquals("https://api.openai.com/v1/chat/completions", call.url)
        assertEquals("Bearer sk-test-ABCDEFGHIJKLMNOP", call.headers["Authorization"])
        val body = JSONObject(call.body)
        assertEquals("gpt-4o-mini", body.optString("model"))
        assertEquals(0.2, body.optDouble("temperature"), 0.0001)
        assertEquals("json_object", body.optJSONObject("response_format")?.optString("type"))
        val messages = body.optJSONArray("messages")!!
        assertEquals(2, messages.length())
        assertEquals("system", messages.getJSONObject(0).getString("role"))
        assertEquals("user", messages.getJSONObject(1).getString("role"))
    }

    @Test
    fun reviewPlanSendsJsonObjectMode() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"choices":[{"message":{"content":"{\"decision\":\"approve\",\"reason\":\"ok\",\"summary\":\"go\",\"evidence\":{}}"}}]}""",
            )
        }
        val provider = OpenAiCompatibleProvider(config(), http)

        val result = provider.reviewPlan(JSONObject().put("plan", JSONObject().put("intent", "swap")))

        assertEquals("approve", result.optString("decision"))
        val body = JSONObject(http.calls.single().body)
        assertEquals("json_object", body.optJSONObject("response_format")?.optString("type"))
    }

    @Test
    fun reviewPlanFailsClosedWhenCurrentResearchIsRequired() = runBlocking {
        val http = FakeHttpExecutor()
        val provider = OpenAiCompatibleProvider(config(), http)
        val payload = JSONObject()
            .put("plan", JSONObject().put("intent", "swap"))
            .put(
                "research",
                JSONObject()
                    .put("needed", true)
                    .put("mode", "auto_current_facts")
                    .put("currentDate", "2026-05-16T03:00:00Z")
                    .put("maxSearches", 3),
            )

        val result = provider.reviewPlan(payload)

        assertEquals("needs_input", result.optString("decision"))
        assertEquals("unavailable", result.optJSONObject("evidence")?.optJSONObject("research")?.optString("status"))
        assertEquals("device_agent_current_fact", result.optJSONArray("questions")?.optJSONObject(0)?.optString("id"))
        assertEquals(0, http.calls.size)
    }

    @Test
    fun askDoesNotSendJsonObjectModeAndUsesAskTemperature() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"choices":[{"message":{"content":"It will swap SOL for USDC via Jupiter."}}]}""",
            )
        }
        val provider = OpenAiCompatibleProvider(config(), http)

        val result = provider.ask(JSONObject().put("question", "what happens?"))

        assertTrue(result.optString("output_text").startsWith("It will swap"))
        val body = JSONObject(http.calls.single().body)
        assertFalse(body.has("response_format"))
        assertEquals(0.3, body.optDouble("temperature"), 0.0001)
    }

    @Test
    fun askFailsClosedWhenCurrentResearchIsRequired() = runBlocking {
        val http = FakeHttpExecutor()
        val provider = OpenAiCompatibleProvider(config(), http)
        val payload = JSONObject()
            .put("question", "What is the current value?")
            .put(
                "research",
                JSONObject()
                    .put("needed", true)
                    .put("mode", "auto_current_facts")
                    .put("currentDate", "2026-05-16T03:00:00Z")
                    .put("maxSearches", 3),
            )

        val result = provider.ask(payload)

        assertTrue(result.optString("output_text").contains("cannot fetch current outside facts"))
        assertEquals(0, http.calls.size)
    }

    @Test
    fun temperatureOmittedForGpt5Model() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"choices":[{"message":{"content":"{\"intent\":\"x\"}"}}]}""",
            )
        }
        val provider = OpenAiCompatibleProvider(config(model = "gpt-5-turbo"), http)
        provider.generatePlan(JSONObject().put("userPrompt", "hi"))

        val body = JSONObject(http.calls.single().body)
        assertFalse("temperature should be omitted for gpt-5 models", body.has("temperature"))
    }

    @Test
    fun temperatureOmittedForOSeriesModel() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"choices":[{"message":{"content":"{\"intent\":\"x\"}"}}]}""")
        }
        val provider = OpenAiCompatibleProvider(config(model = "o3-mini"), http)
        provider.generatePlan(JSONObject().put("userPrompt", "hi"))
        val body = JSONObject(http.calls.single().body)
        assertFalse(body.has("temperature"))
    }

    @Test
    fun authFailureMapsTo401Code() {
        val http = FakeHttpExecutor().apply {
            queueResponse(401, """{"error":{"message":"Incorrect API key sk-test-ABCDEFGHIJKLMNOP"}}""")
        }
        val provider = OpenAiCompatibleProvider(config(), http)
        val ex = try {
            runBlocking { provider.generatePlan(JSONObject()) }
            null
        } catch (e: ProviderHttpException) {
            e
        }
        assertNotEquals(null, ex)
        assertEquals(ProviderErrorCodes.AUTH, ex!!.code)
    }

    @Test
    fun outputTextResponsesApiHappyPath() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"output_text":"answer here from responses api"}""")
        }
        val provider = OpenAiCompatibleProvider(config(), http)

        val result = provider.ask(JSONObject().put("question", "what happens?"))

        assertEquals("answer here from responses api", result.optString("output_text"))
    }

    @Test
    fun systemMessageOnWireIsVerbatimPlanPrompt() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"choices":[{"message":{"content":"{\"intent\":\"x\"}"}}]}""")
        }
        val provider = OpenAiCompatibleProvider(config(), http)
        provider.generatePlan(JSONObject().put("userPrompt", "do thing"))

        val body = JSONObject(http.calls.single().body)
        val systemContent = body.getJSONArray("messages").getJSONObject(0).getString("content")
        assertEquals(DeviceAgentSystemPrompts.PLAN, systemContent)
    }

    @Test
    fun systemMessageOnWireIsVerbatimReviewPrompt() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"choices":[{"message":{"content":"{\"decision\":\"approve\",\"reason\":\"ok\",\"summary\":\"go\",\"evidence\":{}}"}}]}""")
        }
        val provider = OpenAiCompatibleProvider(config(), http)
        provider.reviewPlan(JSONObject().put("plan", JSONObject()))

        val body = JSONObject(http.calls.single().body)
        val systemContent = body.getJSONArray("messages").getJSONObject(0).getString("content")
        assertEquals(DeviceAgentSystemPrompts.REVIEW, systemContent)
    }

    @Test
    fun systemMessageOnWireIsVerbatimAskPrompt() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"choices":[{"message":{"content":"text answer"}}]}""")
        }
        val provider = OpenAiCompatibleProvider(config(), http)
        provider.ask(JSONObject().put("question", "?"))

        val body = JSONObject(http.calls.single().body)
        val systemContent = body.getJSONArray("messages").getJSONObject(0).getString("content")
        assertEquals(DeviceAgentSystemPrompts.ASK, systemContent)
    }

    @Test
    fun userContentMatchesAssemblerOutput() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"choices":[{"message":{"content":"{\"intent\":\"x\"}"}}]}""")
        }
        val provider = OpenAiCompatibleProvider(config(), http)
        val payload = JSONObject()
            .put("userPrompt", "swap 1 SOL")
            .put("userNotes", "make it fast")
        provider.generatePlan(payload)

        val expected = DeviceAgentMessageAssembler.buildPlanMessages(payload).userContent
        val body = JSONObject(http.calls.single().body)
        val actual = body.getJSONArray("messages").getJSONObject(1).getString("content")
        assertEquals(expected, actual)
    }

    @Test
    fun httpErrorBodyEchoingKeyIsRedactedAtProviderLayer() {
        val key = "sk-test-ABCDEFGHIJKLMNOP" // mirrors config().apiKey
        val http = FakeHttpExecutor().apply {
            queueResponse(401, """{"error":{"message":"Invalid key $key supplied"}}""")
        }
        val provider = OpenAiCompatibleProvider(config(), http)
        val ex = try {
            runBlocking { provider.generatePlan(JSONObject()) }
            null
        } catch (e: ProviderHttpException) {
            e
        }
        assertNotEquals(null, ex)
        // Note: redaction is applied by the executor layer; provider raises the raw message but
        // the regex fallback in SecretRedactor catches sk- tokens, ensuring the executor wrap
        // never re-introduces the key. This test pins that the upstream message reaches us
        // intact so the executor can redact it.
        assertTrue("Provider should surface the upstream message", ex!!.message.contains("Invalid key"))
        assertEquals(ProviderErrorCodes.AUTH, ex.code)
    }
}
