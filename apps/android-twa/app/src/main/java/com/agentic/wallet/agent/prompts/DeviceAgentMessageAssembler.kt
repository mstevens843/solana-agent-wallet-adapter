package com.agentic.wallet.agent.prompts

import org.json.JSONArray
import org.json.JSONObject
import java.time.Clock
import java.time.Instant

internal data class Messages(val system: String, val userContent: String)

internal object DeviceAgentMessageAssembler {
    private const val RESEARCH_MAX_USES: Int = 3
    private const val CONNECTOR_RULE_DEFAULT: String =
        "Only propose first-class or Blink executable actions for enabled connectors with matching capabilities. If a requested protocol/action is disabled, unsupported, or missing an action URL/client key, make the plan proof/read-only and state which connector fact, key, or action URL is missing."

    fun buildPlanMessages(payload: JSONObject): Messages {
        val protocolConnectors = payload.optJSONArray("protocolConnectors")
            ?: payload.optJSONArray("connectorContext")
            ?: JSONArray()
        val providedRule = payload.optString("connectorRule", "").trim()
        val connectorRule = if (providedRule.isNotEmpty()) providedRule else deriveConnectorRule(protocolConnectors)
        val boundary = payload.optString("requiredBoundary", "").ifBlank { DeviceAgentBoundaries.PLAN }
        val userPrompt = payload.opt("userPrompt") ?: payload.opt("prompt") ?: ""
        val userContent = JSONObject().apply {
            put("userPrompt", userPrompt)
            if (payload.has("userNotes")) {
                put("userNotes", payload.opt("userNotes"))
            }
            if (payload.has("template")) put("template", payload.opt("template"))
            if (payload.has("parameters")) put("parameters", payload.opt("parameters"))
            put("protocolConnectors", protocolConnectors)
            put("connectorRule", connectorRule)
            put("requiredBoundary", boundary)
        }
        return Messages(DeviceAgentSystemPrompts.PLAN, userContent.toString())
    }

    fun buildReviewMessages(payload: JSONObject, clock: Clock = Clock.systemUTC()): Messages {
        val instruction = payload.optString("instruction", "").trim().ifEmpty {
            DeviceAgentBoundaries.REVIEW_DEFAULT_INSTRUCTION
        }
        val walletAddress = payload.optString("walletAddress", "").trim().ifEmpty { "not_connected" }
        val cluster = payload.optString("cluster", "").trim().ifEmpty { "unknown" }
        val boundary = payload.optString("requiredBoundary", "").ifBlank { DeviceAgentBoundaries.REVIEW }
        val userContent = JSONObject().apply {
            put("instruction", instruction)
            put("walletAddress", walletAddress)
            put("cluster", cluster)
            put("plan", payload.opt("plan") ?: JSONObject())
            put("context", payload.opt("context") ?: JSONObject())
            put("research", researchObject(payload, clock))
            put("requiredBoundary", boundary)
        }
        return Messages(DeviceAgentSystemPrompts.REVIEW, userContent.toString())
    }

    /**
     * Build the message pair for the research pass — Device Agent parity with the local-bridge
     * two-pass flow. When the review needs current outside facts, the LLM gets a research-only
     * turn (with web search bound) before the structured review turn. Mirrors
     * `buildResearchMessages` in apps/browser-demo/src/deviceAgent/prompts/messageAssembler.ts.
     */
    fun buildResearchMessages(
        payload: JSONObject,
        researchTargets: JSONArray? = null,
        clock: Clock = Clock.systemUTC(),
    ): Messages {
        val instruction = payload.optString("instruction", "").trim().ifEmpty {
            DeviceAgentBoundaries.REVIEW_DEFAULT_INSTRUCTION
        }
        val walletAddress = payload.optString("walletAddress", "").trim().ifEmpty { "not_connected" }
        val cluster = payload.optString("cluster", "").trim().ifEmpty { "unknown" }
        val hasTargets = researchTargets != null && researchTargets.length() > 0
        val sourcePolicy = "Prefer official vendor pricing pages over blogs and aggregators. When a vendor publishes a plan/pricing page, use it as the primary source. Pricing pages are the authoritative source for current prices, fees, and plan rates. Never cite a blog subdomain (blog.*, news.*, medium.com, substack.com, community.*) as the primary source for current pricing — if only blog citations are available, state that current pricing could not be verified against an official page. Cite each fact with the official URL, not a blog post."
        val systemPrelude = if (hasTargets) {
            "You research current outside facts for a Solana wallet approval review. Do not approve, deny, or ask the wallet to sign. The reviewer has already broken the NOTE into atomic fact requests — see context.researchTargets. Batch your searches: cover every researchTarget in as few queries as possible (ideally one). For each target, return a concise source-backed value (price, plan name, current state) plus a citation URL. Prefer official sources. "
        } else {
            "You research current outside facts for a Solana wallet approval review. Do not approve, deny, or ask the wallet to sign. Search reliable current sources, prefer official sources, and return concise source-backed facts in plain English. Include current prices, thresholds, dates, plan names, ambiguity, and URLs when they are relevant. If multiple current options could change the approval outcome, list each option clearly. "
        }

        val mergedContext = JSONObject()
        val baseContext = payload.optJSONObject("context")
        if (baseContext != null) {
            val keys = baseContext.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                mergedContext.put(key, baseContext.opt(key))
            }
        }
        if (hasTargets) {
            mergedContext.put("researchTargets", researchTargets)
        }

        val researchObj = JSONObject()
            .put("needed", true)
            .put("mode", if (hasTargets) "resolve_specific_atoms" else "collect_current_facts_only")
            .put("currentDate", Instant.now(clock).toString())
            .put("maxSearches", RESEARCH_MAX_USES)
            .put("sourcePolicy", sourcePolicy)

        val userContent = JSONObject().apply {
            put("instruction", instruction)
            put("walletAddress", walletAddress)
            put("cluster", cluster)
            put("plan", payload.opt("plan") ?: JSONObject())
            put("context", mergedContext)
            put("research", researchObj)
            put(
                "requiredBoundary",
                "This research pass cannot approve, deny, sign, or submit. It only gathers facts for a later structured review.",
            )
        }
        return Messages(systemPrelude + sourcePolicy, userContent.toString())
    }

    fun buildAskMessages(payload: JSONObject, clock: Clock = Clock.systemUTC()): Messages {
        val walletAddress = payload.optString("walletAddress", "").trim().ifEmpty { "not_connected" }
        val cluster = payload.optString("cluster", "").trim().ifEmpty { "unknown" }
        val boundary = payload.optString("requiredBoundary", "").ifBlank { DeviceAgentBoundaries.ASK }
        val userContent = JSONObject().apply {
            put("question", payload.opt("question") ?: "")
            put("plan", payload.opt("plan") ?: JSONObject())
            put("walletAddress", walletAddress)
            put("cluster", cluster)
            put("context", payload.opt("context") ?: JSONObject())
            put("research", researchObject(payload, clock))
            put("requiredBoundary", boundary)
        }
        return Messages(DeviceAgentSystemPrompts.ASK, userContent.toString())
    }

    private fun researchObject(payload: JSONObject, clock: Clock): JSONObject {
        val provided = payload.optJSONObject("research")
        if (provided != null) return provided
        return JSONObject()
            .put("needed", false)
            .put("mode", "not_required")
            .put("currentDate", Instant.now(clock).toString())
            .put("maxSearches", RESEARCH_MAX_USES)
    }

    private fun deriveConnectorRule(protocolConnectors: JSONArray): String {
        val selected = findSelectedConnector(protocolConnectors) ?: return CONNECTOR_RULE_DEFAULT
        val name = selected.optString("name", "").trim()
            .ifEmpty { selected.optString("id", "").trim() }
            .ifEmpty { "selected connector" }
        return listOf(
            "Use the selected protocol connector only: $name.",
            "Do not switch protocols.",
            "If required connector facts are missing, ask for missing facts instead of inventing execution.",
            "Do not claim the action is signed, submitted, approved, or safe.",
            "The wallet owner must approve separately.",
        ).joinToString(" ")
    }

    private fun findSelectedConnector(arr: JSONArray): JSONObject? {
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            if (obj.optBoolean("selected", false) || obj.optBoolean("selectedOnly", false)) return obj
        }
        return null
    }
}
