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
 *   - LLM decision is not "approve"
 */
    fun enforce(reviewResult: JSONObject, payload: JSONObject): JSONObject {
        val bundle = extractBundle(payload) ?: return reviewResult
        val text = reviewResult.optString("text", "")
        if (reviewResult.has("text") && text.isNotBlank() && runCatching { JSONObject(text) }.getOrNull() == null) {
            return reviewResult
        }
        val parsed = parsedReviewResult(reviewResult)
        mergePolicyFindings(parsed, bundle)
        if (!bundle.optBoolean("hasBlockingFailure", false)) return writeBack(reviewResult, parsed)
        val decision = parsed.optString("decision", "").lowercase()
        if (decision != "approve") return writeBack(reviewResult, parsed)

        val validAtomIds = validAtomIds(bundle)
        val evaluations = bundle.optJSONArray("evaluations") ?: JSONArray()
        val failing = mutableListOf<JSONObject>()
        for (i in 0 until evaluations.length()) {
            val ev = evaluations.optJSONObject(i) ?: continue
            val atomId = ev.optString("atomId", "")
            if (ev.has("pass") && !ev.optBoolean("pass", true) && validAtomIds.contains(atomId)) failing.add(ev)
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
        val out = writeBack(reviewResult, parsed)
        out.put(
            "safetyOverride",
            JSONObject()
                .put("reason", "policy_bundle_blocking_failure")
                .put("originalDecision", "approve")
                .put("enforcedDecision", "deny")
                .put("blockingFactIds", blockingFactIds)
        )
        return out
    }

    private fun extractBundle(payload: JSONObject): JSONObject? {
        val context = payload.optJSONObject("context") ?: return null
        return context.optJSONObject("policyBundle")
    }

    private fun parsedReviewResult(reviewResult: JSONObject): JSONObject {
        val text = reviewResult.optString("text", "")
        if (text.isNotBlank()) {
            val parsed = runCatching { JSONObject(text) }.getOrNull()
            if (parsed != null) return parsed
        }
        return JSONObject(reviewResult.toString())
    }

    private fun writeBack(original: JSONObject, parsed: JSONObject): JSONObject {
        return if (original.has("text")) {
            JSONObject(original.toString()).put("text", parsed.toString())
        } else {
            parsed
        }
    }

    private fun validAtomIds(bundle: JSONObject): Set<String> {
        val atoms = bundle.optJSONArray("atoms") ?: JSONArray()
        val ids = mutableSetOf<String>()
        for (i in 0 until atoms.length()) {
            atoms.optJSONObject(i)?.optString("id", "")?.takeIf { it.isNotBlank() }?.let { ids.add(it) }
        }
        if (ids.isNotEmpty()) return ids
        val evaluations = bundle.optJSONArray("evaluations") ?: JSONArray()
        for (i in 0 until evaluations.length()) {
            evaluations.optJSONObject(i)?.optString("atomId", "")?.takeIf { it.isNotBlank() }?.let { ids.add(it) }
        }
        return ids
    }

    private fun mergePolicyFindings(review: JSONObject, bundle: JSONObject) {
        val evaluations = bundle.optJSONArray("evaluations") ?: return
        if (evaluations.length() == 0) return
        val validAtomIds = validAtomIds(bundle)
        val evidence = review.optJSONObject("evidence") ?: JSONObject()
        val findings = evidence.optJSONArray("findings") ?: JSONArray()
        val labels = mutableMapOf<String, Int>()
        for (i in 0 until findings.length()) {
            val label = findings.optJSONObject(i)?.optString("label", "")?.trim()?.lowercase() ?: ""
            if (label.isNotBlank()) labels[label] = i
        }
        val evidenceFactIds = review.optJSONArray("evidenceFactIds") ?: JSONArray()
        val seenFactIds = mutableSetOf<String>()
        for (i in 0 until evidenceFactIds.length()) {
            evidenceFactIds.optString(i, "").takeIf { it.isNotBlank() }?.let { seenFactIds.add(it) }
        }
        val largeBundle = evaluations.length() > 3
        for (i in 0 until evaluations.length()) {
            val ev = evaluations.optJSONObject(i) ?: continue
            val atomId = ev.optString("atomId", "")
            if (!validAtomIds.contains(atomId)) continue
            if (largeBundle && ev.optBoolean("unresolved", false)) continue
            val finding = ev.optJSONObject("finding") ?: continue
            val label = finding.optString("label", "").trim()
            if (label.isBlank()) continue
            if (seenFactIds.add(atomId)) evidenceFactIds.put(atomId)
            val row = JSONObject()
                .put("label", label)
                .put("value", finding.optString("value", ""))
                .put("tone", finding.optString("tone", "neutral"))
                .put("atomId", atomId)
            val key = label.lowercase()
            val existing = labels[key]
            if (existing == null) {
                findings.put(row)
                labels[key] = findings.length() - 1
            } else {
                findings.put(existing, row)
            }
        }
        evidence.put("findings", findings)
        evidence.put("policyAtoms", compactAtoms(bundle))
        val txGateOutcomes = bundle.optJSONObject("txGateOutcomes")
        if (txGateOutcomes != null && txGateOutcomes.length() > 0) evidence.put("policyTxGates", txGateOutcomes)
        review.put("evidence", evidence)
        review.put("evidenceFactIds", evidenceFactIds)
    }

    private fun compactAtoms(bundle: JSONObject): JSONArray {
        val atoms = bundle.optJSONArray("atoms") ?: JSONArray()
        val out = JSONArray()
        for (i in 0 until atoms.length()) {
            val atom = atoms.optJSONObject(i) ?: continue
            out.put(
                JSONObject()
                    .put("id", atom.optString("id", ""))
                    .put("type", atom.optString("type", ""))
                    .put("rawText", atom.optString("rawText", ""))
            )
        }
        return out
    }
}
