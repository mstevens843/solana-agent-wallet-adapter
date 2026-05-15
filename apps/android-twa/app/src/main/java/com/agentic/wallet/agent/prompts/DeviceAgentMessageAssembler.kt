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
            put("research", researchObject(clock))
            put("requiredBoundary", boundary)
        }
        return Messages(DeviceAgentSystemPrompts.REVIEW, userContent.toString())
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
            put("research", researchObject(clock))
            put("requiredBoundary", boundary)
        }
        return Messages(DeviceAgentSystemPrompts.ASK, userContent.toString())
    }

    private fun researchObject(clock: Clock): JSONObject = JSONObject()
        .put("needed", false)
        .put("mode", "not_required")
        .put("currentDate", Instant.now(clock).toString())
        .put("maxSearches", RESEARCH_MAX_USES)

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
