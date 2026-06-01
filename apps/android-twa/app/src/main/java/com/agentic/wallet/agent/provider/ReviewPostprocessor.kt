package com.agentic.wallet.agent.provider

import org.json.JSONArray
import org.json.JSONObject

internal object ReviewPostprocessor {
    fun finalize(result: JSONObject, payload: JSONObject): JSONObject {
        val normalized = normalize(result)
        val researchEvidence = payload.optJSONObject("context")?.optJSONObject("researchEvidence") ?: return normalized
        return attachResearchEvidence(normalized, researchEvidence)
    }

    private fun normalize(result: JSONObject): JSONObject {
        val out = JSONObject(result.toString())
        val decision = firstString(out, "decision", "verdict", "status", "decision_status", "decisionStatus")
        if (decision.isNotBlank()) {
            out.put("decision", normalizeDecision(decision))
        } else if (out.has("approved")) {
            out.put("decision", if (out.optBoolean("approved", false)) "approve" else "deny")
        }
        if (out.optString("reason", "").isBlank()) {
            firstString(out, "rationale", "explanation", "why").takeIf { it.isNotBlank() }?.let {
                out.put("reason", it)
            }
        }
        if (out.optString("summary", "").isBlank()) {
            firstString(out, "result", "answer").takeIf { it.isNotBlank() }?.let {
                out.put("summary", it)
            }
        }
        val evidence = out.optJSONObject("evidence") ?: JSONObject()
        for (key in listOf("findings", "checks", "evidenceRows", "evidence_rows", "sources", "citations")) {
            if (!evidence.has(key) && out.has(key)) {
                evidence.put(key, out.opt(key))
                out.remove(key)
            }
        }
        out.put("evidence", evidence)
        return out
    }

    private fun attachResearchEvidence(result: JSONObject, researchEvidence: JSONObject): JSONObject {
        val out = JSONObject(result.toString())
        val evidence = out.optJSONObject("evidence") ?: JSONObject()
        if (evidence.optJSONObject("research") == null) {
            val research = JSONObject()
                .put("status", researchEvidence.optString("status", "checked"))
                .put("required", researchEvidence.optBoolean("required", true))
            researchEvidence.optString("provider", "").takeIf { it.isNotBlank() }?.let { research.put("provider", it) }
            researchEvidence.optString("checkedAt", "").takeIf { it.isNotBlank() }?.let { research.put("checkedAt", it) }
            evidence.put("research", research)
        }
        val sources = mergeSources(evidence.optJSONArray("sources"), researchEvidence.optJSONArray("sources"))
        if (sources.length() > 0) evidence.put("sources", sources)
        val findings = evidence.optJSONArray("findings") ?: JSONArray()
        val summary = researchEvidence.optString("summary", "")
        if (summary.isNotBlank() && !hasFindingLabel(findings, "current research")) {
            findings.put(JSONObject().put("label", "Current research").put("value", summary).put("tone", "neutral"))
        }
        if (findings.length() > 0) evidence.put("findings", findings)
        out.put("evidence", evidence)
        return out
    }

    private fun mergeSources(existing: JSONArray?, added: JSONArray?): JSONArray {
        val out = JSONArray()
        val seen = mutableSetOf<String>()
        fun append(rows: JSONArray?) {
            if (rows == null) return
            for (i in 0 until rows.length()) {
                val row = rows.optJSONObject(i) ?: continue
                val url = row.optString("url", row.optString("ref", "")).trim()
                if (url.isBlank() || !seen.add(url)) continue
                val next = JSONObject().put("url", url)
                row.optString("title", "").takeIf { it.isNotBlank() }?.let { next.put("title", it) }
                out.put(next)
            }
        }
        append(existing)
        append(added)
        return out
    }

    private fun hasFindingLabel(findings: JSONArray, label: String): Boolean {
        val target = label.trim().lowercase()
        for (i in 0 until findings.length()) {
            val row = findings.optJSONObject(i) ?: continue
            if (row.optString("label", "").trim().lowercase() == target) return true
        }
        return false
    }

    private fun firstString(obj: JSONObject, vararg keys: String): String {
        for (key in keys) {
            val value = obj.optString(key, "")
            if (value.isNotBlank()) return value.trim()
        }
        return ""
    }

    private fun normalizeDecision(value: String): String {
        return when (value.trim().lowercase().replace(Regex("[\\s-]+"), "_")) {
            "approved", "pass", "passed", "allow" -> "approve"
            "denied", "reject", "rejected", "fail", "failed" -> "deny"
            "needsinput", "needs_input", "needs_user_input", "manual_review" -> "needs_input"
            else -> value.trim().lowercase().replace(Regex("[\\s-]+"), "_")
        }
    }
}
