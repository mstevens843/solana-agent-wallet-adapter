package com.agentic.wallet.agent.runtime

import org.json.JSONArray
import org.json.JSONObject

/**
 * Mirrors apps/render-web/src/cloud/policyEnrich.ts +
 * packages/ios-capacitor-bridge/ios/Plugin/AgenticPolicyBundleEnforcer.swift.
 *
 * When the LLM returns decision=approve but the policy bundle in
 * context.policyBundle had a blocking failure, downgrade to deny. Necessary on
 * the BYOK device-agent path because the LLM HTTP call bypasses the cloud's
 * applyServerSideReviewSafety.
 */
internal object PolicyBundleEnforcer {
    /**
     * Inspect the review result text alongside the request payload. Returns the
     * (possibly corrected) result. No-op when:
     *   - no policyBundle on payload.context
     *   - bundle.hasBlockingFailure is false
     *   - LLM result text is not parseable JSON
     *   - LLM decision is not "approve"
     */
    fun enforce(reviewResult: JSONObject, payload: JSONObject): JSONObject {
        val bundle = extractBundle(payload) ?: return reviewResult
        if (!bundle.optBoolean("hasBlockingFailure", false)) return reviewResult
        val text = reviewResult.optString("text", "")
        if (text.isBlank()) return reviewResult
        val parsed = runCatching { JSONObject(text) }.getOrNull() ?: return reviewResult
        val decision = parsed.optString("decision", "").lowercase()
        if (decision != "approve") return reviewResult

        val evaluations = bundle.optJSONArray("evaluations") ?: JSONArray()
        val failing = mutableListOf<JSONObject>()
        for (i in 0 until evaluations.length()) {
            val ev = evaluations.optJSONObject(i) ?: continue
            if (ev.has("pass") && !ev.optBoolean("pass", true)) failing.add(ev)
        }
        val blockingFactIds = JSONArray()
        var firstLabel: String? = null
        for (ev in failing) {
            val atomId = ev.optString("atomId", "")
            if (atomId.isNotEmpty()) blockingFactIds.put(atomId)
            if (firstLabel == null) {
                firstLabel = ev.optJSONObject("finding")?.optString("label")?.takeIf { it.isNotEmpty() }
            }
        }
        val reason = firstLabel?.let { "User policy bundle failed: $it" }
            ?: "User policy bundle has at least one failing rule."

        parsed.put("decision", "deny")
        parsed.put("reason", reason)
        parsed.put("blockingFactIds", blockingFactIds)
        reviewResult.put("text", parsed.toString())
        reviewResult.put(
            "safetyOverride",
            JSONObject()
                .put("reason", "policy_bundle_blocking_failure")
                .put("originalDecision", "approve")
                .put("enforcedDecision", "deny")
                .put("blockingFactIds", blockingFactIds)
        )
        return reviewResult
    }

    private fun extractBundle(payload: JSONObject): JSONObject? {
        val context = payload.optJSONObject("context") ?: return null
        return context.optJSONObject("policyBundle")
    }
}
