package com.agentic.wallet.agent.provider

import org.json.JSONArray
import org.json.JSONObject

internal object ProviderResponseParser {
    private val CODE_FENCE_JSON = Regex("```(?:json)?\\s*([\\s\\S]*?)```", RegexOption.IGNORE_CASE)
    private const val CITATION_CAP = 8
    private const val CITATION_WALK_MAX_DEPTH = 10

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

    /**
     * Extract URL citations from an Anthropic response. Citations live inside `content[i].citations`
     * (web_search tool annotations) as `{ url, title, cited_text? }`. Dedupes by url.
     */
    fun extractAnthropicCitations(payload: JSONObject): List<Citation> {
        val content = payload.optJSONArray("content") ?: return emptyList()
        val seen = mutableSetOf<String>()
        val out = mutableListOf<Citation>()
        for (i in 0 until content.length()) {
            val entry = content.optJSONObject(i) ?: continue
            val citations = entry.optJSONArray("citations") ?: continue
            for (j in 0 until citations.length()) {
                val c = citations.optJSONObject(j) ?: continue
                val url = (c.opt("url") as? String)?.trim().orEmpty()
                if (url.isEmpty() || !seen.add(url)) continue
                val title = c.opt("title") as? String
                val citedText = (c.opt("cited_text") as? String) ?: (c.opt("citedText") as? String)
                out.add(Citation(url = url, title = title, citedText = citedText))
            }
        }
        return out
    }

    /**
     * Extract text from an OpenAI Responses API payload (POST /v1/responses).
     * Prefers `output_text` when present, otherwise walks `output[].content[].text`.
     */
    fun extractResponsesApiText(payload: JSONObject): String {
        val direct = payload.opt("output_text")
        if (direct is String && direct.isNotEmpty()) return direct
        val output = payload.optJSONArray("output") ?: return ""
        val parts = mutableListOf<String>()
        for (i in 0 until output.length()) {
            val entry = output.optJSONObject(i) ?: continue
            val content = entry.optJSONArray("content") ?: continue
            for (j in 0 until content.length()) {
                val piece = content.optJSONObject(j) ?: continue
                val text = piece.opt("text")
                if (text is String && text.isNotEmpty()) parts.add(text)
            }
        }
        return parts.joinToString("\n")
    }

    /**
     * Extract URL citations from an OpenAI Responses API payload. Citations live in two places:
     *   - `output[i].content[j].annotations[k]` (`type: 'url_citation'`, `{ url, title? }`)
     *   - `web_search_call.action.sources[k]` (`{ url, title? }`)
     * Walks the payload tree to depth 10, dedupes by url, caps at 8.
     */
    fun extractResponsesApiCitations(payload: JSONObject): List<Citation> {
        val seen = mutableSetOf<String>()
        val out = mutableListOf<Citation>()
        walkForCitations(payload, 0, seen, out)
        return out
    }

    private fun walkForCitations(value: Any?, depth: Int, seen: MutableSet<String>, out: MutableList<Citation>) {
        if (out.size >= CITATION_CAP || depth > CITATION_WALK_MAX_DEPTH || value == null) return
        when (value) {
            is JSONArray -> {
                for (i in 0 until value.length()) {
                    if (out.size >= CITATION_CAP) return
                    walkForCitations(value.opt(i), depth + 1, seen, out)
                }
            }
            is JSONObject -> {
                val urlValue = value.opt("url")
                if (urlValue is String) {
                    val url = urlValue.trim()
                    if (url.isNotEmpty() && seen.add(url)) {
                        val title = value.opt("title") as? String
                        out.add(Citation(url = url, title = title))
                    }
                }
                val keys = value.keys()
                while (keys.hasNext()) {
                    if (out.size >= CITATION_CAP) return
                    val key = keys.next()
                    walkForCitations(value.opt(key), depth + 1, seen, out)
                }
            }
            // primitives terminate the walk
        }
    }

    /**
     * Extract text from a Gemini native API payload (POST :generateContent).
     * Joins all text parts of the first candidate with newlines.
     */
    fun extractGeminiText(payload: JSONObject): String {
        val candidates = payload.optJSONArray("candidates") ?: return ""
        if (candidates.length() == 0) return ""
        val first = candidates.optJSONObject(0) ?: return ""
        val content = first.optJSONObject("content") ?: return ""
        val parts = content.optJSONArray("parts") ?: return ""
        val out = mutableListOf<String>()
        for (i in 0 until parts.length()) {
            val part = parts.optJSONObject(i) ?: continue
            val text = part.opt("text")
            if (text is String && text.isNotEmpty()) out.add(text)
        }
        return out.joinToString("\n")
    }

    /**
     * Extract URL citations from a Gemini native API payload.
     * Shape: `candidates[0].groundingMetadata.groundingChunks[].web.{ uri, title }`.
     */
    fun extractGeminiCitations(payload: JSONObject): List<Citation> {
        val candidates = payload.optJSONArray("candidates") ?: return emptyList()
        if (candidates.length() == 0) return emptyList()
        val first = candidates.optJSONObject(0) ?: return emptyList()
        val grounding = first.optJSONObject("groundingMetadata") ?: return emptyList()
        val chunks = grounding.optJSONArray("groundingChunks") ?: return emptyList()
        val seen = mutableSetOf<String>()
        val out = mutableListOf<Citation>()
        for (i in 0 until chunks.length()) {
            if (out.size >= CITATION_CAP) break
            val chunk = chunks.optJSONObject(i) ?: continue
            val web = chunk.optJSONObject("web") ?: continue
            val uri = (web.opt("uri") as? String)?.trim().orEmpty()
            if (uri.isEmpty() || !seen.add(uri)) continue
            val title = web.opt("title") as? String
            out.add(Citation(url = uri, title = title))
        }
        return out
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
