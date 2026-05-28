package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.prompts.DeviceAgentMessageAssembler
import com.agentic.wallet.agent.prompts.Messages
import com.agentic.wallet.agent.runtime.RuntimeConfig
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.Instant

// Native Gemini Device Agent provider — hits Google's :generateContent endpoint instead
// of the OpenAI-compatible passthrough. Adds two-pass web research with Google Search
// grounding (`tools: [{ google_search: {} }]`), mirroring AnthropicProvider.runResearchPass
// so external-fact prompts like "check helium mobile. lowest monthly plan. if < $20.
// approve." resolve identically across providers.
//
// Why a separate class from OpenAiCompatibleProvider:
//   - Gemini's /v1beta/openai compat endpoint does NOT support `tools: [{ google_search: {} }]`
//     — the grounding tool is only exposed on the native :generateContent endpoint.
//   - The native request shape (`systemInstruction`, `contents[].parts[]`,
//     `generationConfig.{responseMimeType, temperature, maxOutputTokens}`) is incompatible
//     with chat completions, so it lives in its own class.
//   - Gemini rejects `generationConfig.responseMimeType: 'application/json'` whenever any
//     tool is attached, so the research pass MUST drop responseMimeType.
//   - Routing is by `config.provider == "gemini"` at the dispatcher level.
//
// Kotlin port of apps/browser-demo/src/deviceAgent/provider/geminiNativeProvider.ts.
internal class GeminiNativeProvider(
    private val config: RuntimeConfig,
    private val http: HttpExecutor,
    private val clock: Clock = Clock.systemUTC(),
) : DeviceAgentProvider {

    override suspend fun generatePlan(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(payload)
        val response = postGenerateContent(
            messages,
            jsonObjectMode = true,
            temperature = PLAN_TEMPERATURE,
            maxOutputTokens = PLAN_MAX_TOKENS,
            research = false,
        )
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractGeminiText(response))
    }

    override suspend fun reviewPlan(payload: JSONObject): JSONObject {
        if (researchNeeded(payload)) {
            val enrichedPayload = runResearchPass(payload)
            val reviewPayload = mergeResearchSignal(enrichedPayload)
            val messages = DeviceAgentMessageAssembler.buildReviewMessages(reviewPayload)
            val response = postGenerateContent(
                messages,
                jsonObjectMode = true,
                temperature = REVIEW_TEMPERATURE,
                maxOutputTokens = REVIEW_MAX_TOKENS,
                research = false,
            )
            return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractGeminiText(response))
        }
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(payload)
        val response = postGenerateContent(
            messages,
            jsonObjectMode = true,
            temperature = REVIEW_TEMPERATURE,
            maxOutputTokens = REVIEW_MAX_TOKENS,
            research = false,
        )
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractGeminiText(response))
    }

    override suspend fun ask(payload: JSONObject): JSONObject {
        val research = researchNeeded(payload)
        val messages = DeviceAgentMessageAssembler.buildAskMessages(payload)
        val response = postGenerateContent(
            messages,
            jsonObjectMode = false,
            temperature = ASK_TEMPERATURE,
            maxOutputTokens = ASK_MAX_TOKENS,
            research = research,
        )
        val text = ProviderResponseParser.extractGeminiText(response)
        if (text.isBlank()) {
            throw ProviderHttpException(
                ProviderErrorCodes.INVALID_RESPONSE,
                "Provider response had no answer text.",
            )
        }
        return JSONObject().put("output_text", text)
    }

    private suspend fun runResearchPass(payload: JSONObject): JSONObject {
        return try {
            val messages = DeviceAgentMessageAssembler.buildResearchMessages(payload, researchTargetsForPayload(payload))
            val response = postGenerateContent(
                messages,
                jsonObjectMode = false,
                temperature = REVIEW_TEMPERATURE,
                maxOutputTokens = RESEARCH_MAX_TOKENS,
                research = true,
            )
            val rawSummary = ProviderResponseParser.extractGeminiText(response).trim()
            val rawCitations = ProviderResponseParser.extractGeminiCitations(response)
            val instruction = extractInstructionText(payload)
            val filteredCitations = CitationFilter.filterLowAuthorityCitations(rawCitations, instruction)

            val dropped = rawCitations.isNotEmpty() && filteredCitations.isEmpty()
            val pricingQuestion = CitationFilter.isPricingInstruction(instruction)
            val summary = if (dropped && pricingQuestion) {
                "Current pricing could not be verified against an official source. Ask the user to confirm the plan name and price."
            } else {
                rawSummary.ifEmpty { "Research ran but produced no summary text." }
            }

            if (filteredCitations.isEmpty() && rawSummary.isEmpty()) return payload

            val sources = JSONArray()
            for (c in filteredCitations) {
                val src = JSONObject().put("url", c.url)
                if (c.title != null) src.put("title", c.title)
                sources.put(src)
            }
            val researchEvidence = JSONObject()
                .put("status", "checked")
                .put("required", true)
                .put("provider", "Gemini")
                .put("checkedAt", Instant.now(clock).toString())
                .put("summary", summary)
                .put("sources", sources)
                .put(
                    "sourcePolicy",
                    "Prefer official sources for prices and product facts. When a vendor publishes a plan page, use it as primary. Reject blog subdomains (blog.*, news.*) as primary sources for current pricing. Cite each fact with the official URL.",
                )

            val merged = copyJson(payload)
            val mergedContext = merged.optJSONObject("context") ?: JSONObject()
            mergedContext.put("researchEvidence", researchEvidence)
            merged.put("context", mergedContext)
            merged
        } catch (cancel: kotlinx.coroutines.CancellationException) {
            throw cancel
        } catch (_: Throwable) {
            payload
        }
    }

    private suspend fun postGenerateContent(
        messages: Messages,
        jsonObjectMode: Boolean,
        temperature: Double,
        maxOutputTokens: Int,
        research: Boolean,
    ): JSONObject {
        val apiKey = (config.apiKey ?: "").trim()
        ProviderHttp.assertApiKeyHeaderSafe(apiKey)

        val model = config.model.trim()
        val baseUrl = ProviderHttp.normalizeNativeBaseUrl(config.baseUrl)
        val encodedModel = URLEncoder.encode(model, StandardCharsets.UTF_8)
        val url = "$baseUrl/models/$encodedModel:generateContent"

        val generationConfig = JSONObject()
            .put("temperature", temperature)
            .put("maxOutputTokens", maxOutputTokens)
        // Gemini rejects `responseMimeType: 'application/json'` whenever any tool is attached,
        // so the research pass (which has `tools`) must omit it.
        if (jsonObjectMode && !research) {
            generationConfig.put("responseMimeType", "application/json")
        }

        val body = JSONObject()
            .put(
                "systemInstruction",
                JSONObject().put("parts", JSONArray().put(JSONObject().put("text", messages.system))),
            )
            .put(
                "contents",
                JSONArray().put(
                    JSONObject()
                        .put("role", "user")
                        .put("parts", JSONArray().put(JSONObject().put("text", messages.userContent))),
                ),
            )
            .put("generationConfig", generationConfig)

        if (research) {
            body.put("tools", JSONArray().put(JSONObject().put("google_search", JSONObject())))
        }

        val headers = mapOf("x-goog-api-key" to apiKey)
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

    companion object {
        private const val PLAN_TEMPERATURE: Double = 0.2
        private const val REVIEW_TEMPERATURE: Double = 0.2
        private const val ASK_TEMPERATURE: Double = 0.3
        private const val PLAN_MAX_TOKENS: Int = 1024
        private const val REVIEW_MAX_TOKENS: Int = 1024
        private const val RESEARCH_MAX_TOKENS: Int = 1800
        private const val ASK_MAX_TOKENS: Int = 800

        private fun researchNeeded(payload: JSONObject): Boolean =
            payload.optJSONObject("research")?.optBoolean("needed", false) == true

        private fun extractInstructionText(payload: JSONObject): String {
            val direct = payload.optString("instruction", "")
            if (direct.isNotEmpty()) return direct
            val userPrompt = payload.optString("userPrompt", "")
            if (userPrompt.isNotEmpty()) return userPrompt
            return payload.optString("question", "")
        }

        private fun mergeResearchSignal(payload: JSONObject): JSONObject {
            val merged = copyJson(payload)
            val existing = merged.optJSONObject("research") ?: JSONObject()
            existing.put("needed", false)
            existing.put("mode", "provided_current_facts")
            existing.put("providedEvidence", true)
            merged.put("research", existing)
            return merged
        }

        private fun copyJson(src: JSONObject): JSONObject = JSONObject(src.toString())
    }
}
