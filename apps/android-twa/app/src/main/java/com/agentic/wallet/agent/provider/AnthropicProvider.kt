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
        val response = postMessages(messages, maxTokens = PLAN_MAX_TOKENS, temperature = PLAN_TEMPERATURE)
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractAnthropicText(response))
    }

    override suspend fun reviewPlan(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(payload)
        val response = postMessages(messages, maxTokens = REVIEW_MAX_TOKENS, temperature = REVIEW_TEMPERATURE)
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractAnthropicText(response))
    }

    override suspend fun ask(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildAskMessages(payload)
        val response = postMessages(messages, maxTokens = ASK_MAX_TOKENS, temperature = ASK_TEMPERATURE)
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
    ): JSONObject {
        val apiKey = (config.apiKey ?: "").trim()
        ProviderHttp.assertApiKeyHeaderSafe(apiKey)
        val baseUrl = ProviderHttp.normalizeBaseUrl(config.baseUrl, "anthropic")
        val url = "$baseUrl/messages"
        val body = buildRequestBody(messages, maxTokens, temperature)
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

    private fun buildRequestBody(messages: Messages, maxTokens: Int, temperature: Double): JSONObject {
        val userMessages = JSONArray().put(
            JSONObject()
                .put("role", "user")
                .put("content", messages.userContent),
        )
        return JSONObject()
            .put("model", config.model.trim())
            .put("max_tokens", maxTokens)
            .put("system", messages.system)
            .put("messages", userMessages)
            .put("temperature", temperature)
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
