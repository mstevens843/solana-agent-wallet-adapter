package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.prompts.DeviceAgentMessageAssembler
import com.agentic.wallet.agent.prompts.DeviceAgentSystemPrompts
import com.agentic.wallet.agent.runtime.RuntimeConfig
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AnthropicProviderTest {
    private fun config(model: String = "claude-opus-4-5"): RuntimeConfig = RuntimeConfig(
        provider = "anthropic",
        apiFormat = "anthropic",
        model = model,
        baseUrl = "https://api.anthropic.com",
        apiKey = "sk-ant-test-ABCDEFGHIJKLMNOP",
        walletAddress = null,
    )

    @Test
    fun generatePlanSendsSystemAndUserRoles() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"content":[{"type":"text","text":"{\"intent\":\"swap\",\"route\":\"jupiter\",\"risk\":\"low\",\"approval\":\"once\",\"safeguards\":[\"check slippage\"]}"}]}""",
            )
        }
        val provider = AnthropicProvider(config(), http)

        val result = provider.generatePlan(JSONObject().put("userPrompt", "swap 1 SOL"))

        assertEquals("swap", result.optString("intent"))
        val call = http.calls.single()
        assertEquals("https://api.anthropic.com/v1/messages", call.url)
        assertEquals("sk-ant-test-ABCDEFGHIJKLMNOP", call.headers["x-api-key"])
        assertEquals("2023-06-01", call.headers["anthropic-version"])
        // Phase 3 must not advertise itself as browser-direct
        assertFalse(call.headers.containsKey("anthropic-dangerous-direct-browser-access"))

        val body = JSONObject(call.body)
        assertEquals("claude-opus-4-5", body.optString("model"))
        assertEquals(1024, body.optInt("max_tokens"))
        assertEquals(0.2, body.optDouble("temperature"), 0.0001)
        assertTrue("system field must be top-level", body.has("system"))
        val messages = body.optJSONArray("messages")!!
        assertEquals(1, messages.length())
        assertEquals("user", messages.getJSONObject(0).getString("role"))
        // No web search tools
        assertFalse(body.has("tools"))
    }

    @Test
    fun reviewPlanUses1024MaxTokens() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"content":[{"type":"text","text":"{\"decision\":\"approve\",\"reason\":\"ok\",\"summary\":\"go\",\"evidence\":{}}"}]}""",
            )
        }
        val provider = AnthropicProvider(config(), http)

        val result = provider.reviewPlan(JSONObject().put("plan", JSONObject()))

        assertEquals("approve", result.optString("decision"))
        val body = JSONObject(http.calls.single().body)
        assertEquals(1024, body.optInt("max_tokens"))
    }

    @Test
    fun reviewPlanAttachesWebSearchToolsWhenResearchNeeded() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"content":[{"type":"text","text":"{\"decision\":\"approve\",\"reason\":\"${'$'}15/month is under ${'$'}20.\",\"summary\":\"ok\",\"evidence\":{\"findings\":[{\"label\":\"Monthly rate\",\"value\":\"${'$'}15/month\",\"tone\":\"good\"}]}}"}]}""",
            )
        }
        val provider = AnthropicProvider(config(), http)
        val payload = JSONObject()
            .put("plan", JSONObject())
            .put(
                "research",
                JSONObject()
                    .put("needed", true)
                    .put("mode", "auto_current_facts")
                    .put("currentDate", "2026-05-16T03:00:00Z")
                    .put("maxSearches", 2),
            )

        val result = provider.reviewPlan(payload)

        assertEquals("approve", result.optString("decision"))
        val body = JSONObject(http.calls.single().body)
        val tools = body.optJSONArray("tools") ?: JSONArray()
        assertEquals("web_search_20250305", tools.getJSONObject(0).optString("type"))
        assertEquals("web_search", tools.getJSONObject(0).optString("name"))
        assertEquals(2, tools.getJSONObject(0).optInt("max_uses"))
    }

    @Test
    fun askUses800MaxTokensAndWrapsResponseAsOutputText() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"content":[{"type":"text","text":"It swaps SOL for USDC."}]}""",
            )
        }
        val provider = AnthropicProvider(config(), http)

        val result = provider.ask(JSONObject().put("question", "what happens?"))

        assertEquals("It swaps SOL for USDC.", result.optString("output_text"))
        val body = JSONObject(http.calls.single().body)
        assertEquals(800, body.optInt("max_tokens"))
        assertEquals(0.3, body.optDouble("temperature"), 0.0001)
    }

    @Test
    fun rateLimitMapsToRateLimitedCode() {
        val http = FakeHttpExecutor().apply {
            queueResponse(429, """{"error":{"message":"rate limit"}}""")
        }
        val provider = AnthropicProvider(config(), http)
        val ex = try {
            runBlocking { provider.generatePlan(JSONObject()) }
            null
        } catch (e: ProviderHttpException) {
            e
        }
        assertEquals(ProviderErrorCodes.RATE_LIMITED, ex!!.code)
    }

    @Test
    fun systemFieldOnWireIsVerbatimPlanPrompt() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"content":[{"type":"text","text":"{\"intent\":\"x\"}"}]}""")
        }
        val provider = AnthropicProvider(config(), http)
        provider.generatePlan(JSONObject().put("userPrompt", "do thing"))

        val body = JSONObject(http.calls.single().body)
        assertEquals(DeviceAgentSystemPrompts.PLAN, body.getString("system"))
    }

    @Test
    fun systemFieldOnWireIsVerbatimReviewPrompt() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"content":[{"type":"text","text":"{\"decision\":\"approve\",\"reason\":\"ok\",\"summary\":\"go\",\"evidence\":{}}"}]}""")
        }
        val provider = AnthropicProvider(config(), http)
        provider.reviewPlan(JSONObject().put("plan", JSONObject()))

        val body = JSONObject(http.calls.single().body)
        assertEquals(DeviceAgentSystemPrompts.REVIEW, body.getString("system"))
    }

    @Test
    fun systemFieldOnWireIsVerbatimAskPrompt() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"content":[{"type":"text","text":"the answer"}]}""")
        }
        val provider = AnthropicProvider(config(), http)
        provider.ask(JSONObject().put("question", "?"))

        val body = JSONObject(http.calls.single().body)
        assertEquals(DeviceAgentSystemPrompts.ASK, body.getString("system"))
    }

    @Test
    fun userContentMatchesAssemblerOutput() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"content":[{"type":"text","text":"{\"intent\":\"x\"}"}]}""")
        }
        val provider = AnthropicProvider(config(), http)
        val payload = JSONObject()
            .put("userPrompt", "swap 1 SOL")
            .put("userNotes", "make it fast")
        provider.generatePlan(payload)

        val expected = DeviceAgentMessageAssembler.buildPlanMessages(payload).userContent
        val body = JSONObject(http.calls.single().body)
        val actual = body.getJSONArray("messages").getJSONObject(0).getString("content")
        assertEquals(expected, actual)
    }

    @Test
    fun httpErrorBodyEchoingKeyIsRedactedAtProviderLayer() {
        val key = "sk-ant-test-ABCDEFGHIJKLMNOP"
        val http = FakeHttpExecutor().apply {
            queueResponse(403, """{"type":"error","error":{"type":"forbidden","message":"key $key not allowed"}}""")
        }
        val provider = AnthropicProvider(config(), http)
        val ex = try {
            runBlocking { provider.generatePlan(JSONObject()) }
            null
        } catch (e: ProviderHttpException) {
            e
        }
        assertNotEquals(null, ex)
        assertEquals(ProviderErrorCodes.AUTH, ex!!.code)
        assertTrue("Provider should surface the upstream message", ex.message.contains("not allowed"))
    }
}
