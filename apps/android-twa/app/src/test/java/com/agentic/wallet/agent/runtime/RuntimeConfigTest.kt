package com.agentic.wallet.agent.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RuntimeConfigTest {
    @Test
    fun fromJsonAcceptsCanonicalOpenAiCompatibleFormat() {
        val config = RuntimeConfig.fromJson(
            JSONObject()
                .put("provider", "openai")
                .put("apiFormat", "openai-compatible")
                .put("model", "gpt-5")
                .put("apiKey", "sk-test"),
        )

        assertEquals("openai-compatible", config!!.apiFormat)
        assertNull(config.validate())
    }

    @Test
    fun fromJsonCanonicalizesLegacyOpenAiFormat() {
        val config = RuntimeConfig.fromJson(
            JSONObject()
                .put("provider", "openai")
                .put("apiFormat", "openai")
                .put("model", "gpt-5")
                .put("apiKey", "sk-test"),
        )

        assertEquals("openai-compatible", config!!.apiFormat)
        assertNull(config.validate())
    }
}
