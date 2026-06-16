package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.runtime.ProviderFailedException
import com.agentic.wallet.agent.runtime.RuntimeConfig
import com.agentic.wallet.agent.runtime.RuntimeErrorCodes
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class BridgePairedRoutingTest {
    private val pairedConfig = RuntimeConfig(
        provider = "paired-bridge",
        apiFormat = "paired-bridge",
        model = "",
        baseUrl = null,
        apiKey = null,
        walletAddress = null,
    )

    private class RecordingProvider : DeviceAgentProvider {
        var generateCalls = 0
        var lastPayload: JSONObject? = null
        override suspend fun generatePlan(payload: JSONObject): JSONObject {
            generateCalls += 1
            lastPayload = payload
            return JSONObject().put("routed", "bridge")
        }
        override suspend fun reviewPlan(payload: JSONObject): JSONObject = JSONObject().put("routed", "bridge")
        override suspend fun ask(payload: JSONObject): JSONObject = JSONObject().put("output_text", "bridge")
        override suspend fun localize(payload: JSONObject): JSONObject = JSONObject().put("output_text", "bridge")
    }

    @Test
    fun pairedBridgeConfigValidatesWithoutApiKey() {
        assertTrue(pairedConfig.isPairedBridge())
        assertNull("paired-bridge needs no apiKey/model/format", pairedConfig.validate())
    }

    @Test
    fun routesPairedBridgeToInjectedProvider() = runBlocking {
        val bridge = RecordingProvider()
        val executor = DeviceAgentProviderExecutor(bridgeRelayProvider = bridge)
        val result = executor.generatePlan(pairedConfig, JSONObject().put("prompt", "swap 1 SOL"))
        assertEquals("bridge", result.optString("routed"))
        assertEquals(1, bridge.generateCalls)
        assertEquals("swap 1 SOL", bridge.lastPayload?.optString("prompt"))
    }

    @Test
    fun pairedBridgeWithoutProviderFailsCleanly() = runBlocking {
        val executor = DeviceAgentProviderExecutor() // no bridge provider injected
        try {
            executor.generatePlan(pairedConfig, JSONObject())
            fail("expected ProviderFailedException")
        } catch (e: ProviderFailedException) {
            assertEquals(RuntimeErrorCodes.INVALID_CONFIG, e.error.code)
        }
    }
}
