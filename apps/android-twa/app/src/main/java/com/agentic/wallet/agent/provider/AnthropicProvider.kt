package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.prompts.DeviceAgentMessageAssembler
import com.agentic.wallet.agent.prompts.Messages
import com.agentic.wallet.agent.runtime.RuntimeConfig
import org.json.JSONArray
import org.json.JSONObject

internal class AnthropicProvider(
    private val config: RuntimeConfig,
    private val http: HttpExecutor,
) : DeviceAgentProvider {

    override suspend fun generatePlan(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(payload)
        val response = postMessages(messages, maxTokens = PLAN_MAX_TOKENS, temperature = PLAN_TEMPERATURE, payload = payload)
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractAnthropicText(response))
    }

    override suspend fun reviewPlan(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(payload)
        val response = postMessages(messages, maxTokens = REVIEW_MAX_TOKENS, temperature = REVIEW_TEMPERATURE, payload = payload)
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractAnthropicText(response))
    }

    override suspend fun ask(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildAskMessages(payload)
        val response = postMessages(messages, maxTokens = ASK_MAX_TOKENS, temperature = ASK_TEMPERATURE, payload = payload)
        val text = ProviderResponseParser.extractAnthropicText(response)
        if (text.isBlank()) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_RESPONSE, "Provider response had no answer text.")
        }
        return JSONObject().put("output_text", text)
    }

    private suspend fun postMessages(
        messages: Messages,
        maxTokens: Int,
        temperature: Double,
        payload: JSONObject,
    ): JSONObject {
        val apiKey = (config.apiKey ?: "").trim()
        ProviderHttp.assertApiKeyHeaderSafe(apiKey)
        val baseUrl = ProviderHttp.normalizeBaseUrl(config.baseUrl, "anthropic")
        val url = "$baseUrl/messages"
        val body = buildRequestBody(messages, maxTokens, temperature, payload)
        val headers = mapOf(
            "x-api-key" to apiKey,
            "anthropic-version" to ANTHROPIC_VERSION,
        )
        val response = http.postJson(url, headers, body.toString())
        val errorCode = ProviderHttp.mapHttpStatusToErrorCode(response.status)
        if (errorCode != null) {
            throw ProviderHttpException(
                errorCode,
                ProviderHttp.composeErrorMessage(response.status, response.body),
            )
        }
        return try {
            JSONObject(response.body)
        } catch (_: Throwable) {
            throw ProviderHttpException(
                ProviderErrorCodes.INVALID_RESPONSE,
                "Provider response was not valid JSON.",
            )
        }
    }

    private fun buildRequestBody(
        messages: Messages,
        maxTokens: Int,
        temperature: Double,
        payload: JSONObject,
    ): JSONObject {
        val userMessages = JSONArray().put(
            JSONObject()
                .put("role", "user")
                .put("content", messages.userContent),
        )
        val body = JSONObject()
            .put("model", config.model.trim())
            .put("max_tokens", maxTokens)
            .put("system", messages.system)
            .put("messages", userMessages)
            .put("temperature", temperature)
        if (researchNeeded(payload)) {
            body.put(
                "tools",
                JSONArray().put(
                    JSONObject()
                        .put("type", "web_search_20250305")
                        .put("name", "web_search")
                        .put("max_uses", researchMaxUses(payload))
                        .put(
                            "user_location",
                            JSONObject()
                                .put("type", "approximate")
                                .put("country", "US")
                                .put("timezone", "America/Los_Angeles"),
                        ),
                ),
            )
        }
        return body
    }

    private fun researchNeeded(payload: JSONObject): Boolean =
        payload.optJSONObject("research")?.optBoolean("needed", false) == true

    private fun researchMaxUses(payload: JSONObject): Int {
        val raw = payload.optJSONObject("research")?.opt("maxSearches")
        val numeric = when (raw) {
            is Number -> raw.toInt()
            else -> 3
        }
        return numeric.coerceIn(1, 5)
    }

    companion object {
        private const val ANTHROPIC_VERSION: String = "2023-06-01"
        private const val PLAN_MAX_TOKENS: Int = 1024
        private const val REVIEW_MAX_TOKENS: Int = 1024
        private const val ASK_MAX_TOKENS: Int = 800
        private const val PLAN_TEMPERATURE: Double = 0.2
        private const val REVIEW_TEMPERATURE: Double = 0.2
        private const val ASK_TEMPERATURE: Double = 0.3
    }
}
