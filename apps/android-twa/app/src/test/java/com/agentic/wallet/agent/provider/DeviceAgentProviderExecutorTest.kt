package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.runtime.ProviderFailedException
import com.agentic.wallet.agent.runtime.RuntimeConfig
import com.agentic.wallet.agent.runtime.RuntimeConfigSubcodes
import com.agentic.wallet.agent.runtime.RuntimeErrorCodes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException

class DeviceAgentProviderExecutorTest {
    private val apiKey = "sk-test-EXAMPLEKEY12345"

    private fun config(apiFormat: String): RuntimeConfig = RuntimeConfig(
        provider = if (apiFormat == "anthropic") "anthropic" else "openai",
        apiFormat = apiFormat,
        model = if (apiFormat == "anthropic") "claude-opus-4-5" else "gpt-4o-mini",
        baseUrl = if (apiFormat == "anthropic") "https://api.anthropic.com" else "https://api.openai.com",
        apiKey = apiKey,
        walletAddress = null,
    )

    @Test
    fun generatePlanRoutesThroughOpenAi() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"choices":[{"message":{"content":"{\"intent\":\"transfer\",\"route\":\"system\",\"risk\":\"low\",\"approval\":\"once\",\"safeguards\":[]}"}}]}""",
            )
        }
        val executor = DeviceAgentProviderExecutor(http)
        val result = executor.generatePlan(config("openai-compatible"), JSONObject().put("userPrompt", "send 1 SOL"))
        assertEquals("transfer", result.optString("intent"))
    }

    @Test
    fun generatePlanStillAcceptsLegacyOpenAiFormat() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"choices":[{"message":{"content":"{\"intent\":\"transfer\",\"route\":\"system\",\"risk\":\"low\",\"approval\":\"once\",\"safeguards\":[]}"}}]}""",
            )
        }
        val executor = DeviceAgentProviderExecutor(http)
        val result = executor.generatePlan(config("openai"), JSONObject().put("userPrompt", "send 1 SOL"))
        assertEquals("transfer", result.optString("intent"))
    }

    @Test
    fun generatePlanRoutesThroughAnthropic() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"content":[{"type":"text","text":"{\"intent\":\"transfer\",\"route\":\"system\",\"risk\":\"low\",\"approval\":\"once\",\"safeguards\":[]}"}]}""",
            )
        }
        val executor = DeviceAgentProviderExecutor(http)
        val result = executor.generatePlan(config("anthropic"), JSONObject().put("userPrompt", "send 1 SOL"))
        assertEquals("transfer", result.optString("intent"))
    }

    @Test
    fun authFailureBecomesProviderFailedWithAuthCode() {
        val http = FakeHttpExecutor().apply {
            queueResponse(401, """{"error":{"message":"Invalid key $apiKey"}}""")
        }
        val executor = DeviceAgentProviderExecutor(http)
        val ex = try {
            runBlocking { executor.generatePlan(config("openai-compatible"), JSONObject()) }
            null
        } catch (e: ProviderFailedException) {
            e
        }
        assertNotEquals(null, ex)
        assertEquals(ProviderErrorCodes.AUTH, ex!!.error.code)
        // API key must not leak through the redacted message
        assertFalse("API key must be redacted, got: ${ex.error.message}", ex.error.message.contains(apiKey))
    }

    @Test
    fun rateLimitBecomesProviderFailedWithRateLimitedCode() {
        val http = FakeHttpExecutor().apply {
            queueResponse(429, """{"error":{"message":"slow down"}}""")
        }
        val executor = DeviceAgentProviderExecutor(http)
        val ex = try {
            runBlocking { executor.reviewPlan(config("openai-compatible"), JSONObject()) }
            null
        } catch (e: ProviderFailedException) {
            e
        }
        assertEquals(ProviderErrorCodes.RATE_LIMITED, ex!!.error.code)
    }

    @Test
    fun socketTimeoutBecomesProviderFailedWithTimeoutCode() {
        val http = FakeHttpExecutor().apply {
            queueFailure(ProviderHttpException(ProviderErrorCodes.TIMEOUT, "Provider request timed out."))
        }
        val executor = DeviceAgentProviderExecutor(http)
        val ex = try {
            runBlocking { executor.ask(config("anthropic"), JSONObject().put("question", "hi")) }
            null
        } catch (e: ProviderFailedException) {
            e
        }
        assertEquals(ProviderErrorCodes.TIMEOUT, ex!!.error.code)
    }

    @Test
    fun upstreamErrorMaps500ToProviderUpstream() {
        val http = FakeHttpExecutor().apply {
            queueResponse(500, """{"error":{"message":"oops"}}""")
        }
        val executor = DeviceAgentProviderExecutor(http)
        val ex = try {
            runBlocking { executor.generatePlan(config("openai-compatible"), JSONObject()) }
            null
        } catch (e: ProviderFailedException) {
            e
        }
        assertEquals(ProviderErrorCodes.UPSTREAM, ex!!.error.code)
    }

    @Test
    fun malformedResponseBecomesInvalidResponse() {
        val http = FakeHttpExecutor().apply {
            queueResponse(200, """{"choices":[{"message":{"content":"not json at all"}}]}""")
        }
        val executor = DeviceAgentProviderExecutor(http)
        val ex = try {
            runBlocking { executor.generatePlan(config("openai-compatible"), JSONObject()) }
            null
        } catch (e: ProviderFailedException) {
            e
        }
        assertEquals(ProviderErrorCodes.INVALID_RESPONSE, ex!!.error.code)
    }

    @Test
    fun unsupportedApiFormatBecomesInvalidConfig() {
        val executor = DeviceAgentProviderExecutor(FakeHttpExecutor())
        val ex = try {
            runBlocking {
                executor.generatePlan(
                    config("openai-compatible").copy(apiFormat = "weird-format"),
                    JSONObject(),
                )
            }
            null
        } catch (e: ProviderFailedException) {
            e
        }
        assertEquals(RuntimeErrorCodes.INVALID_CONFIG, ex!!.error.code)
        assertEquals(RuntimeConfigSubcodes.UNSUPPORTED_FORMAT, ex.error.subcode)
    }

    @Test
    fun socketTimeoutFromHttpExecutorMapsToTimeout() {
        val http = FakeHttpExecutor().apply {
            queueFailure(SocketTimeoutException("timed out"))
        }
        val executor = DeviceAgentProviderExecutor(http)
        val ex = try {
            runBlocking { executor.generatePlan(config("openai-compatible"), JSONObject()) }
            null
        } catch (e: ProviderFailedException) {
            e
        }
        assertEquals(ProviderErrorCodes.TIMEOUT, ex!!.error.code)
    }

    @Test
    fun wrappedSocketTimeoutFromHttpExecutorMapsToTimeout() {
        val http = FakeHttpExecutor().apply {
            queueFailure(RuntimeException("wrapped timeout", SocketTimeoutException("timed out")))
        }
        val executor = DeviceAgentProviderExecutor(http)
        val ex = try {
            runBlocking { executor.generatePlan(config("openai-compatible"), JSONObject()) }
            null
        } catch (e: ProviderFailedException) {
            e
        }
        assertEquals(ProviderErrorCodes.TIMEOUT, ex!!.error.code)
    }

    @Test
    fun cancellationPropagatesWithoutProviderFailedWrapper() {
        val http = FakeHttpExecutor().apply {
            queueFailure(CancellationException("runtime stop"))
        }
        val executor = DeviceAgentProviderExecutor(http)
        val ex = runCatching {
            runBlocking { executor.generatePlan(config("openai-compatible"), JSONObject()) }
        }.exceptionOrNull()

        assertTrue("Expected CancellationException, got $ex", ex is CancellationException)
    }

    @Test
    fun askReturnsOutputTextThroughExecutorOnOpenAi() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"choices":[{"message":{"content":"This is a concise answer."}}]}""",
            )
        }
        val executor = DeviceAgentProviderExecutor(http)
        val result = executor.ask(config("openai"), JSONObject().put("question", "what happens?"))
        assertEquals("This is a concise answer.", result.optString("output_text"))
    }

    @Test
    fun askReturnsOutputTextThroughExecutorOnAnthropic() = runBlocking {
        val http = FakeHttpExecutor().apply {
            queueResponse(
                200,
                """{"content":[{"type":"text","text":"This is a concise answer."}]}""",
            )
        }
        val executor = DeviceAgentProviderExecutor(http)
        val result = executor.ask(config("anthropic"), JSONObject().put("question", "what happens?"))
        assertEquals("This is a concise answer.", result.optString("output_text"))
    }
}
