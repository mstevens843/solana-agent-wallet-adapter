package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.prompts.DeviceAgentMessageAssembler
import com.agentic.wallet.agent.prompts.Messages
import com.agentic.wallet.agent.runtime.RuntimeConfig
import org.json.JSONArray
import org.json.JSONObject
import java.time.Clock
import java.time.Instant

// Native OpenAI Device Agent provider — hits the Responses API (/v1/responses) instead
// of chat completions. Adds two-pass web research with the `web_search_preview` tool,
// mirroring AnthropicProvider.runResearchPass so the Helium-style "check X. if < $20.
// approve." prompts resolve identically across providers.
//
// Why a separate class from OpenAiCompatibleProvider:
//   - Responses API uses `instructions` + `input` (not `messages`) and `max_output_tokens`
//     (not `max_tokens` or `max_completion_tokens`).
//   - Structured output uses `text.format.type = 'json_schema'` (NOT `json_object`, which
//     requires the literal word "json" in the input field and 400s on our JSON-stringified
//     userContent). Mirrors the server's pattern at packages/mcp-server/src/aiPlanner.ts.
//   - Web search tool wiring is OpenAI-direct only; OpenRouter and Custom passthroughs
//     do not expose `web_search_preview` and must keep the fail-closed path.
//   - Routing is by `config.provider == "openai"` at the dispatcher level.
//
// Kotlin port of apps/browser-demo/src/deviceAgent/provider/openAiNativeProvider.ts.
internal class OpenAiNativeProvider(
    private val config: RuntimeConfig,
    private val http: HttpExecutor,
    private val clock: Clock = Clock.systemUTC(),
) : DeviceAgentProvider {

    override suspend fun generatePlan(payload: JSONObject): JSONObject {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(payload)
        val response = postResponses(
            messages,
            responseSchema = PLAN_SCHEMA,
            temperature = PLAN_TEMPERATURE,
            maxOutputTokens = PLAN_MAX_TOKENS,
            research = false,
        )
        return ProviderResponseParser.parseModelJson(ProviderResponseParser.extractResponsesApiText(response))
    }

    override suspend fun reviewPlan(payload: JSONObject): JSONObject {
        if (researchNeeded(payload)) {
            val enrichedPayload = runResearchPass(payload)
            val reviewPayload = mergeResearchSignal(enrichedPayload)
            val messages = DeviceAgentMessageAssembler.buildReviewMessages(reviewPayload)
            val response = postResponses(
                messages,
                responseSchema = REVIEW_SCHEMA,
                temperature = REVIEW_TEMPERATURE,
                maxOutputTokens = REVIEW_MAX_TOKENS,
                research = false,
            )
            return ReviewPostprocessor.finalize(
                ProviderResponseParser.parseModelJson(ProviderResponseParser.extractResponsesApiText(response)),
                reviewPayload,
            )
        }
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(payload)
        val response = postResponses(
            messages,
            responseSchema = REVIEW_SCHEMA,
            temperature = REVIEW_TEMPERATURE,
            maxOutputTokens = REVIEW_MAX_TOKENS,
            research = false,
        )
        return ReviewPostprocessor.finalize(
            ProviderResponseParser.parseModelJson(ProviderResponseParser.extractResponsesApiText(response)),
            payload,
        )
    }

    override suspend fun ask(payload: JSONObject): JSONObject {
        val research = researchNeeded(payload)
        val messages = DeviceAgentMessageAssembler.buildAskMessages(payload)
        val response = postResponses(
            messages,
            responseSchema = null,
            temperature = ASK_TEMPERATURE,
            maxOutputTokens = ASK_MAX_TOKENS,
            research = research,
        )
        val text = ProviderResponseParser.extractResponsesApiText(response)
        if (text.isBlank()) {
            throw ProviderHttpException(
                ProviderErrorCodes.INVALID_RESPONSE,
                "Provider response had no answer text.",
            )
        }
        return JSONObject().put("output_text", text)
    }

    /**
     * Research pass mirroring AnthropicProvider.runResearchPass. Runs a Responses API call
     * with `web_search_preview` bound, captures the research summary + citations, filters
     * low-authority citations for pricing questions, and returns the payload with
     * `context.researchEvidence` populated for the second (structured) pass.
     * Failures are non-fatal — the original payload is returned unchanged.
     */
    private suspend fun runResearchPass(payload: JSONObject): JSONObject {
        return try {
            val messages = DeviceAgentMessageAssembler.buildResearchMessages(payload, researchTargetsForPayload(payload))
            val response = postResponses(
                messages,
                responseSchema = null,
                temperature = REVIEW_TEMPERATURE,
                maxOutputTokens = RESEARCH_MAX_TOKENS,
                research = true,
            )
            val rawSummary = ProviderResponseParser.extractResponsesApiText(response).trim()
            val rawCitations = ProviderResponseParser.extractResponsesApiCitations(response)
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
                .put("provider", "OpenAI")
                .put("checkedAt", Instant.now(clock).toString())
                .put("summary", summary)
                .put("sources", sources)
                .put(
                    "sourcePolicy",
                    "Prefer official vendor pricing pages over blogs. Reject blog subdomains (blog.*, news.*) as primary sources for current prices. Cite each fact with the official URL.",
                )

            val merged = copyJson(payload)
            val mergedContext = merged.optJSONObject("context") ?: JSONObject()
            mergedContext.put("researchEvidence", researchEvidence)
            merged.put("context", mergedContext)
            merged
        } catch (cancel: kotlinx.coroutines.CancellationException) {
            // Structured-concurrency cancellation must propagate. The executor expects it.
            throw cancel
        } catch (_: Throwable) {
            payload
        }
    }

    private suspend fun postResponses(
        messages: Messages,
        responseSchema: ResponseSchema?,
        temperature: Double,
        maxOutputTokens: Int,
        research: Boolean,
    ): JSONObject {
        val apiKey = (config.apiKey ?: "").trim()
        ProviderHttp.assertApiKeyHeaderSafe(apiKey)

        val baseUrl = ProviderHttp.normalizeBaseUrl(config.baseUrl, "openai-compatible")
        val url = "$baseUrl/responses"

        val model = config.model.trim()
        val reasoning = ProviderHttp.isReasoningModel(model)

        val body = JSONObject()
            .put("model", model)
            .put("instructions", messages.system)
            .put("input", messages.userContent)
            .put("max_output_tokens", ProviderHttp.effectiveMaxOutputTokens(model, maxOutputTokens))
            .put("store", false)

        if (responseSchema != null) {
            // json_schema (NOT json_object): json_object requires the literal word "json" in
            // the input field, which our JSON-stringified userContent does not contain.
            val format = JSONObject()
                .put("type", "json_schema")
                .put("name", responseSchema.name)
                .put("strict", responseSchema.strict)
                .put("schema", responseSchema.schema)
            body.put(
                "text",
                JSONObject()
                    .put("verbosity", responseSchema.verbosity)
                    .put("format", format),
            )
        }

        if (!reasoning) {
            body.put("temperature", temperature)
        } else {
            body.put("reasoning", JSONObject().put("effort", OPENAI_REASONING_EFFORT))
        }

        if (research) {
            body.put("tools", JSONArray().put(webSearchTool()))
            body.put("tool_choice", "auto")
            if (!isOpenRouterConfig()) {
                body.put("include", JSONArray().put("web_search_call.action.sources"))
            }
        }

        val headers = if (isOpenRouterConfig()) {
            mapOf(
                "Authorization" to "Bearer $apiKey",
                "X-OpenRouter-Metadata" to "enabled",
            ) + ProviderHttp.openRouterAttributionHeaders(true)
        } else {
            mapOf("Authorization" to "Bearer $apiKey")
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

    private data class ResponseSchema(
        val name: String,
        val strict: Boolean,
        val schema: JSONObject,
        val verbosity: String,
    )

    private fun isOpenRouterConfig(): Boolean =
        config.provider.trim().equals("openrouter", ignoreCase = true) ||
            (config.baseUrl ?: "").contains("openrouter.ai", ignoreCase = true)

    private fun webSearchTool(): JSONObject =
        if (isOpenRouterConfig()) {
            JSONObject()
                .put("type", "openrouter:web_search")
                .put(
                    "parameters",
                    JSONObject()
                        .put("engine", "auto")
                        .put("max_total_results", 3)
                        .put(
                            "user_location",
                            JSONObject()
                                .put("type", "approximate")
                                .put("country", "US")
                                .put("timezone", "America/Los_Angeles"),
                        ),
                )
        } else {
            openAiWebSearchTool()
        }

    companion object {
        private const val PLAN_TEMPERATURE: Double = 0.2
        private const val REVIEW_TEMPERATURE: Double = 0.2
        private const val ASK_TEMPERATURE: Double = 0.3
        private const val PLAN_MAX_TOKENS: Int = 1024
        private const val REVIEW_MAX_TOKENS: Int = 1800
        private const val RESEARCH_MAX_TOKENS: Int = 1800
        private const val ASK_MAX_TOKENS: Int = 800
        private const val OPENAI_REASONING_EFFORT: String = "low"

        // Plan stays terse; Review bumps to 'medium' so reconciler prose has room.
        private const val OPENAI_PLAN_VERBOSITY: String = "low"
        private const val OPENAI_REVIEW_VERBOSITY: String = "medium"

        private val PLAN_SCHEMA = ResponseSchema(
            name = "agentic_device_plan",
            strict = true,
            schema = buildPlanJsonSchema(),
            verbosity = OPENAI_PLAN_VERBOSITY,
        )

        // evidence is intentionally open-shaped, so strict:false.
        private val REVIEW_SCHEMA = ResponseSchema(
            name = "agentic_device_review",
            strict = false,
            schema = buildReviewJsonSchema(),
            verbosity = OPENAI_REVIEW_VERBOSITY,
        )

        private fun buildPlanJsonSchema(): JSONObject =
            JSONObject()
                .put("type", "object")
                .put("additionalProperties", false)
                .put(
                    "properties",
                    JSONObject()
                        .put("intent", JSONObject().put("type", "string"))
                        .put("route", JSONObject().put("type", "string"))
                        // Short label only — keeps the plan-card RISK box a clean Low/Medium/High.
                        .put("risk", JSONObject().put("type", "string").put("enum", JSONArray().put("low").put("medium").put("high")))
                        .put("approval", JSONObject().put("type", "string"))
                        .put(
                            "safeguards",
                            JSONObject()
                                .put("type", "array")
                                .put("items", JSONObject().put("type", "string")),
                        ),
                )
                .put(
                    "required",
                    JSONArray().put("intent").put("route").put("risk").put("approval").put("safeguards"),
                )

        private fun buildReviewJsonSchema(): JSONObject {
            val decisionEnum = JSONArray().put("approve").put("deny").put("needs_input")
            val inputKindEnum = JSONArray().put("text").put("select").put("number")
            val reviewerIdEnum = JSONArray().put("risk").put("quote").put("policy").put("protocol")

            val stringArraySchema = JSONObject()
                .put("type", "array")
                .put("items", JSONObject().put("type", "string"))

            val findingItem = JSONObject()
                .put("type", "object")
                .put("additionalProperties", true)
                .put(
                    "properties",
                    JSONObject()
                        .put("label", JSONObject().put("type", "string"))
                        .put("value", JSONObject().put("type", "string"))
                        .put("tone", JSONObject().put("type", "string").put("enum", JSONArray().put("good").put("warn").put("neutral").put("fail"))),
                )
                .put("required", JSONArray().put("label").put("value").put("tone"))

            val sourceItem = JSONObject()
                .put("type", "object")
                .put("additionalProperties", true)
                .put(
                    "properties",
                    JSONObject()
                        .put("title", JSONObject().put("type", "string"))
                        .put("url", JSONObject().put("type", "string")),
                )
                .put("required", JSONArray().put("url"))

            val questionItem = JSONObject()
                .put("type", "object")
                .put("additionalProperties", false)
                .put(
                    "properties",
                    JSONObject()
                        .put("id", JSONObject().put("type", "string"))
                        .put("prompt", JSONObject().put("type", "string"))
                        .put("inputKind", JSONObject().put("type", "string").put("enum", inputKindEnum))
                        .put(
                            "options",
                            stringArraySchema,
                        )
                        .put("required", JSONObject().put("type", "boolean"))
                        .put("hint", JSONObject().put("type", "string")),
                )
                .put("required", JSONArray().put("id").put("prompt").put("inputKind"))

            val reviewerItem = JSONObject()
                .put("type", "object")
                .put("additionalProperties", false)
                .put(
                    "properties",
                    JSONObject()
                        .put("id", JSONObject().put("type", "string").put("enum", reviewerIdEnum))
                        .put("decision", JSONObject().put("type", "string").put("enum", decisionEnum))
                        .put("reason", JSONObject().put("type", "string"))
                        .put("summary", JSONObject().put("type", "string")),
                )
                .put("required", JSONArray().put("id").put("decision").put("reason"))

            return JSONObject()
                .put("type", "object")
                .put("additionalProperties", false)
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
                                .put("additionalProperties", true)
                                .put(
                                    "properties",
                                    JSONObject()
                                        .put("findings", JSONObject().put("type", "array").put("items", findingItem))
                                        .put("sources", JSONObject().put("type", "array").put("items", sourceItem))
                                        .put(
                                            "research",
                                            JSONObject()
                                                .put("type", "object")
                                                .put("additionalProperties", true)
                                                .put("properties", JSONObject().put("status", JSONObject().put("type", "string"))),
                                        )
                                        .put("policiesApplied", stringArraySchema),
                                ),
                        )
                        .put(
                            "questions",
                            JSONObject()
                                .put("type", "array")
                                .put("maxItems", 3)
                                .put("items", questionItem),
                        )
                        .put(
                            "reviewers",
                            JSONObject()
                                .put("type", "array")
                                .put("maxItems", 4)
                                .put("items", reviewerItem),
                        )
                        .put(
                            "evidenceFactIds",
                            JSONObject()
                                .put("type", "array")
                                .put("items", JSONObject().put("type", "string")),
                        )
                        .put(
                            "blockingFactIds",
                            JSONObject()
                                .put("type", "array")
                                .put("items", JSONObject().put("type", "string")),
                        )
                        .put(
                            "missingFactIds",
                            JSONObject()
                                .put("type", "array")
                                .put("items", JSONObject().put("type", "string")),
                        )
                        .put("confidence", JSONObject().put("type", "string").put("enum", JSONArray().put("high").put("medium").put("low"))),
                )
                .put("required", JSONArray().put("decision").put("reason").put("summary").put("evidence"))
        }

    private fun openAiWebSearchTool(): JSONObject =
        JSONObject()
            .put("type", "web_search_preview")
            .put(
                    "user_location",
                    JSONObject()
                        .put("type", "approximate")
                        .put("country", "US")
                        .put("timezone", "America/Los_Angeles"),
                )

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
