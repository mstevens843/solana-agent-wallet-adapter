package com.agentic.wallet.agent.provider

import org.json.JSONObject

internal object ProviderResponseParser {
    private val CODE_FENCE_JSON = Regex("```(?:json)?\\s*([\\s\\S]*?)```", RegexOption.IGNORE_CASE)

    fun extractOpenAiText(payload: JSONObject): String {
        val outputText = payload.opt("output_text")
        if (outputText is String && outputText.isNotEmpty()) return outputText
        val choices = payload.optJSONArray("choices") ?: return ""
        if (choices.length() == 0) return ""
        val first = choices.optJSONObject(0) ?: return ""
        val message = first.optJSONObject("message")
        if (message != null) {
            val content = message.opt("content")
            if (content is String) return content
        }
        val direct = first.opt("text")
        if (direct is String && direct.isNotEmpty()) return direct
        return ""
    }

    fun extractAnthropicText(payload: JSONObject): String {
        val content = payload.optJSONArray("content") ?: return ""
        val parts = mutableListOf<String>()
        for (i in 0 until content.length()) {
            val entry = content.optJSONObject(i) ?: continue
            val text = entry.opt("text")
            if (text is String && text.isNotEmpty()) parts.add(text)
        }
        return parts.joinToString("\n")
    }

    fun parseModelJson(text: String): JSONObject {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) {
            throw ProviderHttpException(
                ProviderErrorCodes.INVALID_RESPONSE,
                "Provider response was empty.",
            )
        }
        val seen = mutableSetOf<String>()
        val candidates = mutableListOf<String>().apply {
            add(trimmed)
            for (match in CODE_FENCE_JSON.findAll(trimmed)) {
                add(match.groupValues[1].trim())
            }
            addAll(balancedJsonObjectCandidates(trimmed))
        }
        for (candidate in candidates) {
            if (candidate.isEmpty() || !seen.add(candidate)) continue
            try {
                return JSONObject(candidate)
            } catch (_: Throwable) {
                // try next candidate
            }
        }
        throw ProviderHttpException(
            ProviderErrorCodes.INVALID_RESPONSE,
            "Provider response was not valid JSON.",
        )
    }

    private fun balancedJsonObjectCandidates(text: String): List<String> {
        val results = mutableListOf<String>()
        var depth = 0
        var start = -1
        var inString = false
        var escape = false
        for (i in text.indices) {
            val ch = text[i]
            if (escape) {
                escape = false
                continue
            }
            if (ch == '\\' && inString) {
                escape = true
                continue
            }
            if (ch == '"') {
                inString = !inString
                continue
            }
            if (inString) continue
            when (ch) {
                '{' -> {
                    if (depth == 0) start = i
                    depth += 1
                }
                '}' -> {
                    if (depth > 0) {
                        depth -= 1
                        if (depth == 0 && start >= 0) {
                            results.add(text.substring(start, i + 1))
                            start = -1
                        }
                    }
                }
            }
        }
        return results
    }
}
