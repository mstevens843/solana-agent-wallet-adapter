package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.prompts.DeviceAgentMessageAssembler
import com.agentic.wallet.agent.prompts.Messages
import com.agentic.wallet.agent.runtime.RuntimeConfig
import org.json.JSONArray
import org.json.JSONObject

internal class OpenAiCompatibleProvider(
    private val config: RuntimeConfig,
    private val http: HttpExecutor,
) : DeviceAgentProvider {

    override suspend fun generatePlan(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(payload)
        val response = postChatCompletion(
            messages,
            jsonObjectMode = true,
            temperature = PLAN_TEMPERATURE,
            maxTokens = PLAN_MAX_TOKENS,
        )
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractOpenAiText(response))
    }

    override suspend fun reviewPlan(payload: JSONObject): JSONObject {
        if (researchNeeded(payload)) {
            return currentResearchUnavailableReview()
        }
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(payload)
        val response = postChatCompletion(
            messages,
            jsonObjectMode = true,
            temperature = REVIEW_TEMPERATURE,
            maxTokens = REVIEW_MAX_TOKENS,
        )
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractOpenAiText(response))
    }

    override suspend fun ask(payload: JSONObject): JSONObject {
        if (researchNeeded(payload)) {
            return JSONObject().put(
                "output_text",
                CURRENT_RESEARCH_UNAVAILABLE_REASON,
            )
        }
        val messages = DeviceAgentMessageAssembler.buildAskMessages(payload)
        val response = postChatCompletion(
            messages,
            jsonObjectMode = false,
            temperature = ASK_TEMPERATURE,
            maxTokens = ASK_MAX_TOKENS,
        )
        val text = ProviderResponseParser.extractOpenAiText(response)
        if (text.isBlank()) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_RESPONSE, "Provider response had no answer text.")
        }
        return JSONObject().put("output_text", text)
    }

    private suspend fun postChatCompletion(
        messages: Messages,
        jsonObjectMode: Boolean,
        temperature: Double,
        maxTokens: Int,
    ): JSONObject {
        val apiKey = (config.apiKey ?: "").trim()
        ProviderHttp.assertApiKeyHeaderSafe(apiKey)
        val baseUrl = ProviderHttp.normalizeBaseUrl(config.baseUrl, "openai-compatible")
        val url = "$baseUrl/chat/completions"
        val body = buildRequestBody(messages, jsonObjectMode, temperature, maxTokens)
        val headers = mapOf(
            "Authorization" to "Bearer $apiKey",
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
        jsonObjectMode: Boolean,
        temperature: Double,
        maxTokens: Int,
    ): JSONObject {
        val msgArray = JSONArray()
            .put(JSONObject().put("role", "system").put("content", messages.system))
            .put(JSONObject().put("role", "user").put("content", messages.userContent))
        val body = JSONObject()
            .put("model", config.model.trim())
            .put("messages", msgArray)
            .put(ProviderHttp.tokenLimitKey(config.model), maxTokens)
        if (jsonObjectMode) {
            body.put("response_format", JSONObject().put("type", "json_object"))
        }
        if (!ProviderHttp.isDefaultTemperatureOnlyModel(config.model)) {
            body.put("temperature", temperature)
        }
        return body
    }

    private fun researchNeeded(payload: JSONObject): Boolean =
        payload.optJSONObject("research")?.optBoolean("needed", false) == true

    private fun currentResearchUnavailableReview(): JSONObject = JSONObject()
        .put("decision", "needs_input")
        .put("reason", CURRENT_RESEARCH_UNAVAILABLE_REASON)
        .put("summary", "Current outside facts are required before the Device Agent can decide.")
        .put(
            "evidence",
            JSONObject()
                .put(
                    "research",
                    JSONObject()
                        .put("status", "unavailable")
                        .put("provider", "openai-compatible")
                        .put("required", true),
                )
                .put(
                    "findings",
                    JSONArray().put(
                        JSONObject()
                            .put("label", "Research needed")
                            .put("value", CURRENT_RESEARCH_UNAVAILABLE_REASON)
                            .put("tone", "warn"),
                    ),
                ),
        )
        .put(
            "questions",
            JSONArray().put(
                JSONObject()
                    .put("id", "device_agent_current_fact")
                    .put("prompt", "What source-backed current value should be checked?")
                    .put("inputKind", "text")
                    .put("required", true),
            ),
        )
        .put("evidenceFactIds", JSONArray())
        .put("blockingFactIds", JSONArray())
        .put("missingFactIds", JSONArray())
        .put("confidence", "low")

    companion object {
        private const val CURRENT_RESEARCH_UNAVAILABLE_REASON: String =
            "Device Agent OpenAI-compatible mode cannot fetch current outside facts yet. Use Anthropic Device Agent or Local Bridge, or provide a source-backed current value."
        private const val PLAN_TEMPERATURE: Double = 0.2
        private const val REVIEW_TEMPERATURE: Double = 0.2
        private const val ASK_TEMPERATURE: Double = 0.3
        private const val PLAN_MAX_TOKENS: Int = 1024
        private const val REVIEW_MAX_TOKENS: Int = 1024
        private const val ASK_MAX_TOKENS: Int = 800
    }
}
