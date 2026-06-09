package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.prompts.DeviceAgentMessageAssembler
import com.agentic.wallet.agent.prompts.Messages
import com.agentic.wallet.agent.runtime.RuntimeConfig
import org.json.JSONArray
import org.json.JSONObject
import java.time.Clock
import java.time.Instant

// Anthropic Device Agent provider — POST /v1/messages with optional web_search tool.
// Two-pass research flow: when research.needed=true, runs a free-text research call with
// web_search bound (no JSON constraint), captures filtered citations + summary, then runs
// a structured review pass with the research evidence injected into context.
// Mirrors apps/browser-demo/src/deviceAgent/provider/anthropicProvider.ts (which omits the
// browser CORS header — Android's HttpURLConnection doesn't need it).
internal class AnthropicProvider(
    private val config: RuntimeConfig,
    private val http: HttpExecutor,
    private val clock: Clock = Clock.systemUTC(),
) : DeviceAgentProvider {

    override suspend fun generatePlan(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(payload)
        val response = postMessages(messages, PLAN_MAX_TOKENS, PLAN_TEMPERATURE, payload)
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractAnthropicText(response))
    }

    override suspend fun reviewPlan(payload: JSONObject): JSONObject {
        // Two-pass flow for parity with the local-bridge planner: when the review needs outside
        // facts, run a research-only call (web_search bound, no JSON requirement) first, then a
        // structured-output call with the research summary embedded in context. Avoids the model
        // juggling "search the web" + "return JSON" at the same time (Helium NOTE single-pass
        // returned $20 — a matching plan — vs $15 from the two-pass local-bridge).
        if (researchNeeded(payload)) {
            val enriched = runResearchPass(payload)
            val reviewPayload = mergeResearchSignal(enriched)
            val messages = DeviceAgentMessageAssembler.buildReviewMessages(reviewPayload)
            val response = postMessages(messages, REVIEW_MAX_TOKENS, REVIEW_TEMPERATURE, reviewPayload)
            return ReviewPostprocessor.finalize(
                ProviderResponseParser.parseModelJson(ProviderResponseParser.extractAnthropicText(response)),
                reviewPayload,
            )
        }
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(payload)
        val response = postMessages(messages, REVIEW_MAX_TOKENS, REVIEW_TEMPERATURE, payload)
        return ReviewPostprocessor.finalize(
            ProviderResponseParser.parseModelJson(ProviderResponseParser.extractAnthropicText(response)),
            payload,
        )
    }

    override suspend fun ask(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildAskMessages(payload)
        val response = postMessages(messages, ASK_MAX_TOKENS, ASK_TEMPERATURE, payload)
        val text = ProviderResponseParser.extractAnthropicText(response)
        if (text.isBlank()) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_RESPONSE, "Provider response had no answer text.")
        }
        return JSONObject().put("output_text", text)
    }

    /**
     * Research pass — separate LLM call with web search bound. Captures the model's research
     * summary + citations and returns the original payload with `context.researchEvidence`
     * populated, ready for the structured review pass to consume. Failures are non-fatal.
     */
    private suspend fun runResearchPass(payload: JSONObject): JSONObject {
        return try {
            val messages = DeviceAgentMessageAssembler.buildResearchMessages(payload, researchTargetsForPayload(payload))
            // Force research.needed=true on the inner payload so postMessages attaches web_search.
            val innerPayload = copyJson(payload)
            val innerResearch = innerPayload.optJSONObject("research") ?: JSONObject()
            innerResearch.put("needed", true)
            innerPayload.put("research", innerResearch)

            val response = postMessages(messages, REVIEW_MAX_TOKENS, REVIEW_TEMPERATURE, innerPayload)
            val rawSummary = ProviderResponseParser.extractAnthropicText(response).trim()
            val rawCitations = ProviderResponseParser.extractAnthropicCitations(response)
            val instruction = extractInstructionText(payload)
            val filteredCitations = CitationFilter.filterLowAuthorityCitations(rawCitations, instruction)

            // A pricing question with no usable official citation is unverified — whether citations
            // were filtered out as low-authority OR the provider returned none at all (a model
            // answering from training because its web-search tool silently never ran, the
            // OpenRouter+Claude Helium "$0"). Never propagate an un-sourced price; force needs_input.
            val pricingQuestion = CitationFilter.isPricingInstruction(instruction)
            val unverifiedPricing = pricingQuestion && filteredCitations.isEmpty()
            val summary = if (unverifiedPricing) {
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
                .put("provider", "Anthropic")
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
            // Research pass failure must not block the review — return the payload unchanged.
            payload
        }
    }

    private suspend fun postMessages(
        messages: Messages,
        maxTokens: Int,
        temperature: Double,
        payload: JSONObject,
    ): JSONObject {
        val apiKey = (config.apiKey ?: "").trim()
        ProviderHttp.assertApiKeyHeaderSafe(apiKey)
        val apiFormat = if (isOpenRouterConfig()) "openai-compatible" else "anthropic"
        val baseUrl = ProviderHttp.normalizeBaseUrl(config.baseUrl, apiFormat)
        val url = "$baseUrl/messages"
        val body = buildRequestBody(messages, maxTokens, temperature, payload)
        val headers = if (isOpenRouterConfig()) {
            mapOf(
                "Authorization" to "Bearer $apiKey",
                "X-OpenRouter-Metadata" to "enabled",
            ) + ProviderHttp.openRouterAttributionHeaders(true)
        } else {
            mapOf(
                "x-api-key" to apiKey,
                "anthropic-version" to ANTHROPIC_VERSION,
            )
        }
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
                    webSearchTool(payload),
                ),
            )
        }
        return body
    }

    private fun isOpenRouterConfig(): Boolean =
        config.provider.trim().equals("openrouter", ignoreCase = true) ||
            (config.baseUrl ?: "").contains("openrouter.ai", ignoreCase = true)

    // This provider always speaks the Anthropic Messages format (/messages), whether direct or
    // via OpenRouter's Anthropic-compat skin. OpenRouter's openrouter:web_search server tool only
    // works on its Chat Completions / Responses endpoints — NOT the Messages skin — so binding it
    // here meant the tool was silently dropped and Claude answered ungrounded (the
    // OpenRouter+Claude Helium "$0" bug). Always bind Anthropic's NATIVE web_search tool;
    // OpenRouter's skin forwards native tool use to Anthropic 1P.
    private fun webSearchTool(payload: JSONObject): JSONObject =
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
            )

    companion object {
        private const val ANTHROPIC_VERSION: String = "2023-06-01"
        private const val PLAN_MAX_TOKENS: Int = 1024
        private const val REVIEW_MAX_TOKENS: Int = 1800
        private const val ASK_MAX_TOKENS: Int = 800
        private const val PLAN_TEMPERATURE: Double = 0.2
        private const val REVIEW_TEMPERATURE: Double = 0.2
        private const val ASK_TEMPERATURE: Double = 0.3

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
