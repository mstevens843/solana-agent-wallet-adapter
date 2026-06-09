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
//     `generationConfig.{responseMimeType,responseSchema,temperature,maxOutputTokens}`) is incompatible
//     with chat completions, so it lives in its own class.
//   - Gemini rejects JSON response config whenever any tool is attached, so the research
//     pass MUST drop responseMimeType/responseSchema.
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
            responseSchema = PLAN_RESPONSE_SCHEMA,
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
                responseSchema = REVIEW_RESPONSE_SCHEMA,
                temperature = REVIEW_TEMPERATURE,
                maxOutputTokens = REVIEW_MAX_TOKENS,
                research = false,
            )
            return ReviewPostprocessor.finalize(
                ProviderResponseParser.parseModelJson(ProviderResponseParser.extractGeminiText(response)),
                reviewPayload,
            )
        }
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(payload)
        val response = postGenerateContent(
            messages,
            jsonObjectMode = true,
            responseSchema = REVIEW_RESPONSE_SCHEMA,
            temperature = REVIEW_TEMPERATURE,
            maxOutputTokens = REVIEW_MAX_TOKENS,
            research = false,
        )
        return ReviewPostprocessor.finalize(
            ProviderResponseParser.parseModelJson(ProviderResponseParser.extractGeminiText(response)),
            payload,
        )
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
        responseSchema: JSONObject? = null,
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
        // Gemini rejects JSON response config whenever any tool is attached, so the
        // research pass (which has `tools`) must omit it.
        if (jsonObjectMode && !research) {
            generationConfig.put("responseMimeType", "application/json")
            if (responseSchema != null) generationConfig.put("responseSchema", responseSchema)
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
        private const val REVIEW_MAX_TOKENS: Int = 1800
        private const val RESEARCH_MAX_TOKENS: Int = 1800
        private const val ASK_MAX_TOKENS: Int = 800

        private val STRING_ARRAY_SCHEMA = JSONObject()
            .put("type", "array")
            .put("items", JSONObject().put("type", "string"))

        private val FINDING_SCHEMA = JSONObject()
            .put("type", "object")
            .put(
                "properties",
                JSONObject()
                    .put("label", JSONObject().put("type", "string"))
                    .put("value", JSONObject().put("type", "string"))
                    .put("tone", JSONObject().put("type", "string").put("enum", JSONArray().put("good").put("warn").put("neutral").put("fail"))),
            )
            .put("required", JSONArray().put("label").put("value").put("tone"))
            .put("propertyOrdering", JSONArray().put("label").put("value").put("tone"))

        private val SOURCE_SCHEMA = JSONObject()
            .put("type", "object")
            .put(
                "properties",
                JSONObject()
                    .put("title", JSONObject().put("type", "string"))
                    .put("url", JSONObject().put("type", "string")),
            )
            .put("required", JSONArray().put("url"))
            .put("propertyOrdering", JSONArray().put("title").put("url"))

        private val PLAN_RESPONSE_SCHEMA: JSONObject = JSONObject()
            .put("type", "object")
            .put(
                "properties",
                JSONObject()
                    .put("intent", JSONObject().put("type", "string"))
                    .put("route", JSONObject().put("type", "string"))
                    .put("risk", JSONObject().put("type", "string"))
                    .put("approval", JSONObject().put("type", "string"))
                    .put("safeguards", STRING_ARRAY_SCHEMA),
            )
            .put("required", JSONArray().put("intent").put("route").put("risk").put("approval").put("safeguards"))
            .put("propertyOrdering", JSONArray().put("intent").put("route").put("risk").put("approval").put("safeguards"))

        private val REVIEW_RESPONSE_SCHEMA: JSONObject = buildReviewResponseSchema()

        private fun buildReviewResponseSchema(): JSONObject {
            val decisionEnum = JSONArray().put("approve").put("deny").put("needs_input")
            val inputKindEnum = JSONArray().put("text").put("select").put("number")
            val reviewerIdEnum = JSONArray().put("risk").put("quote").put("policy").put("protocol")
            val confidenceEnum = JSONArray().put("high").put("medium").put("low")

            val questionItem = JSONObject()
                .put("type", "object")
                .put(
                    "properties",
                    JSONObject()
                        .put("id", JSONObject().put("type", "string"))
                        .put("prompt", JSONObject().put("type", "string"))
                        .put("inputKind", JSONObject().put("type", "string").put("enum", inputKindEnum))
                        .put("options", STRING_ARRAY_SCHEMA)
                        .put("required", JSONObject().put("type", "boolean"))
                        .put("hint", JSONObject().put("type", "string")),
                )
                .put("required", JSONArray().put("id").put("prompt").put("inputKind"))
                .put("propertyOrdering", JSONArray().put("id").put("prompt").put("inputKind").put("options").put("required").put("hint"))

            val reviewerItem = JSONObject()
                .put("type", "object")
                .put(
                    "properties",
                    JSONObject()
                        .put("id", JSONObject().put("type", "string").put("enum", reviewerIdEnum))
                        .put("decision", JSONObject().put("type", "string").put("enum", decisionEnum))
                        .put("reason", JSONObject().put("type", "string"))
                        .put("summary", JSONObject().put("type", "string")),
                )
                .put("required", JSONArray().put("id").put("decision").put("reason"))
                .put("propertyOrdering", JSONArray().put("id").put("decision").put("reason").put("summary"))

            return JSONObject()
                .put("type", "object")
                .put(
                    "properties",
                    JSONObject()
                        .put("decision", JSONObject().put("type", "string").put("enum", decisionEnum))
                        .put("reason", JSONObject().put("type", "string"))
                        .put("summary", JSONObject().put("type", "string"))
                        .put(
                            "evidence",
                            JSONObject()
                                .put("type", "object")
                                .put(
                                    "properties",
                                    JSONObject()
                                        .put("findings", JSONObject().put("type", "array").put("items", FINDING_SCHEMA))
                                        .put("sources", JSONObject().put("type", "array").put("items", SOURCE_SCHEMA))
                                        .put(
                                            "research",
                                            JSONObject()
                                                .put("type", "object")
                                                .put("properties", JSONObject().put("status", JSONObject().put("type", "string"))),
                                        )
                                        .put("policiesApplied", STRING_ARRAY_SCHEMA),
                                )
                                .put("propertyOrdering", JSONArray().put("findings").put("sources").put("research").put("policiesApplied")),
                        )
                        .put("questions", JSONObject().put("type", "array").put("maxItems", 3).put("items", questionItem))
                        .put("reviewers", JSONObject().put("type", "array").put("maxItems", 4).put("items", reviewerItem))
                        .put("evidenceFactIds", STRING_ARRAY_SCHEMA)
                        .put("blockingFactIds", STRING_ARRAY_SCHEMA)
                        .put("missingFactIds", STRING_ARRAY_SCHEMA)
                        .put("confidence", JSONObject().put("type", "string").put("enum", confidenceEnum)),
                )
                .put("required", JSONArray().put("decision").put("reason").put("summary").put("evidence"))
                .put(
                    "propertyOrdering",
                    JSONArray()
                        .put("decision")
                        .put("reason")
                        .put("summary")
                        .put("evidence")
                        .put("questions")
                        .put("reviewers")
                        .put("evidenceFactIds")
                        .put("blockingFactIds")
                        .put("missingFactIds")
                        .put("confidence"),
                )
        }

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
