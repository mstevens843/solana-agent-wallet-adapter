package com.agentic.wallet.agent.provider

import org.json.JSONObject

internal class ProviderHttpException(
    val code: String,
    override val message: String,
) : RuntimeException(message)

internal object ProviderHttp {
    private const val OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
    private const val ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
    private const val GEMINI_DEFAULT_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

    private val ANTHROPIC_VERSION_SEGMENT = Regex("/v\\d+(/|$)", RegexOption.IGNORE_CASE)
    private val OPENAI_VERSION_SEGMENT = Regex("/v\\d+(beta)?(/|$)", RegexOption.IGNORE_CASE)
    private val OPENAI_SUFFIX = Regex("/openai$", RegexOption.IGNORE_CASE)
    private val OPENAI_COMPAT_SUFFIX = Regex("/openai/?$", RegexOption.IGNORE_CASE)
    private val VERSION_SEGMENT = Regex("/v\\d+(beta)?(/|$)", RegexOption.IGNORE_CASE)

    fun mapHttpStatusToErrorCode(status: Int): String? = when (status) {
        in 200..299 -> null
        401, 403 -> ProviderErrorCodes.AUTH
        429 -> ProviderErrorCodes.RATE_LIMITED
        408, 504 -> ProviderErrorCodes.TIMEOUT
        in 500..599 -> ProviderErrorCodes.UPSTREAM
        else -> ProviderErrorCodes.INVALID_RESPONSE
    }

    fun normalizeBaseUrl(raw: String?, apiFormat: String): String {
        val trimmed = raw?.trim()?.trimEnd('/').orEmpty()
        if (trimmed.isEmpty()) {
            return if (apiFormat == "anthropic") ANTHROPIC_DEFAULT_BASE_URL else OPENAI_DEFAULT_BASE_URL
        }
        if (apiFormat == "anthropic") {
            return if (ANTHROPIC_VERSION_SEGMENT.containsMatchIn(trimmed)) trimmed else "$trimmed/v1"
        }
        if (OPENAI_VERSION_SEGMENT.containsMatchIn(trimmed) || OPENAI_SUFFIX.containsMatchIn(trimmed)) {
            return trimmed
        }
        return "$trimmed/v1"
    }

    fun isDefaultTemperatureOnlyModel(model: String): Boolean {
        val normalized = model.trim().lowercase()
        if (normalized.isEmpty()) return false
        return normalized.startsWith("gpt-5") ||
            normalized.contains("/gpt-5") ||
            Regex("^o\\d").containsMatchIn(normalized) ||
            normalized.startsWith("o-") ||
            normalized.contains("/o1") ||
            normalized.contains("/o3") ||
            normalized.contains("/o4")
    }

    // GPT-5 / o-series chat completions reject `max_tokens` and require `max_completion_tokens`.
    // Mirrors `tokenLimitKey()` in apps/browser-demo/src/deviceAgent/provider/providerHttp.ts.
    fun tokenLimitKey(model: String): String =
        if (isDefaultTemperatureOnlyModel(model)) "max_completion_tokens" else "max_tokens"

    // Kept separate from isDefaultTemperatureOnlyModel even when they overlap — OpenAI may
    // diverge them; the Responses API `reasoning.effort` field is conceptually distinct
    // from the temperature drop.
    fun isReasoningModel(model: String): Boolean = isDefaultTemperatureOnlyModel(model)

    /**
     * Map an OpenAI-compat Gemini baseUrl to the native :generateContent base.
     *
     * Browser-demo stores Gemini's baseUrl as `https://generativelanguage.googleapis.com/v1beta/openai`
     * (because the rest of the stack speaks OpenAI-compat). The native endpoint lives at
     * `/v1beta` — without the `/openai` suffix. Strip it. Idempotent: already-native URLs pass through.
     * Mirrors `normalizeNativeBaseUrl()` in geminiNativeProvider.ts.
     */
    fun normalizeNativeBaseUrl(raw: String?): String {
        val trimmed = raw?.trim()?.trimEnd('/').orEmpty()
        if (trimmed.isEmpty()) return GEMINI_DEFAULT_NATIVE_BASE_URL
        val stripped = OPENAI_COMPAT_SUFFIX.replace(trimmed, "")
        if (VERSION_SEGMENT.containsMatchIn(stripped)) return stripped
        return "$stripped/v1beta"
    }

    /**
     * Rejects an API key that would produce a malformed HTTP header.
     *
     * Defensive check at the provider-call boundary; `RuntimeConfig.validate()` already screens
     * blank keys upstream, but a key that *survived* validation with hidden control chars or
     * copy-paste artifacts (CR/LF, BOM, non-ASCII separators) would corrupt the request line.
     * Mirrors `firstInvalidAiApiKeyCharacter` from `apps/browser-demo/src/planner.ts:1994-2006`.
     *
     * @throws ProviderHttpException with code [ProviderErrorCodes.INVALID_CONFIG] when the key
     *  is empty/blank or contains a code point outside ASCII printable range (`0x21..0x7e`).
     */
    fun assertApiKeyHeaderSafe(value: String) {
        if (value.isEmpty()) {
            throw ProviderHttpException(
                ProviderErrorCodes.INVALID_CONFIG,
                "AI API key is empty. Re-enter the key from the provider dashboard.",
            )
        }
        var index = 0
        while (index < value.length) {
            val codePoint = value.codePointAt(index)
            if (codePoint < 0x21 || codePoint > 0x7e) {
                throw ProviderHttpException(
                    ProviderErrorCodes.INVALID_CONFIG,
                    "AI API key contains unsupported characters. Paste the key again as plain text and remove hidden separators or non-ASCII characters.",
                )
            }
            index += Character.charCount(codePoint)
        }
    }

    fun composeErrorMessage(status: Int, body: String): String {
        val parsedBody = body.takeIf { it.isNotBlank() }?.let {
            try {
                JSONObject(it)
            } catch (_: Throwable) {
                null
            }
        }
        val rawMessage = parsedBody?.let { extractProviderErrorMessage(it) }.orEmpty()
        val base = rawMessage.ifBlank { "AI provider returned HTTP $status." }
        val explanation = providerStatusExplanation(status)
        if (explanation.isBlank()) return base.trim()
        val trimmed = base.trim()
        val endsTerminal = trimmed.endsWith(".") || trimmed.endsWith("?") || trimmed.endsWith("!")
        return if (endsTerminal) "$trimmed $explanation" else "$trimmed. $explanation"
    }

    private fun extractProviderErrorMessage(json: JSONObject): String {
        val errorField = json.opt("error") ?: return ""
        if (errorField is String) return errorField
        if (errorField is JSONObject) {
            val message = errorField.opt("message")
            if (message is String) return message
        }
        return ""
    }

    fun providerStatusExplanation(status: Int): String = when (status) {
        400 -> "That means the provider rejected the request before drafting. Check the API key, selected model, API format, base URL, and whether this key can use that model."
        401 -> "That means the key is missing, invalid, or not being sent correctly. Re-enter the API key and make sure it belongs to this provider."
        403 -> "That means the key reached the provider but is not allowed to use this model or project. Check permissions, billing, and provider access."
        404 -> "That usually means the model or endpoint was not found. Check the model name, API format, and base URL."
        408 -> "That means the provider took too long to answer. Try again, or use a smaller or faster model."
        409 -> "That means the provider reported a temporary conflict. Retry the draft in a moment."
        422 -> "That means the provider could not accept part of the request. Check the model, response format, and request settings."
        429 -> "That means too many requests or quota is exhausted. Wait a minute, reduce retries, or check the provider quota and billing."
        500 -> "That means the provider hit an internal error. Retry in a moment or switch models."
        502 -> "That means a gateway between Agentic and the provider failed. Retry in a moment."
        503 -> "That means the provider is temporarily unavailable or overloaded. Wait a little and retry; the API key is usually not the problem."
        504 -> "That means the provider timed out before finishing. Retry, or choose a faster model."
        else -> when {
            status in 400..499 -> "That means the provider rejected the request. Check key permissions, model name, base URL, and provider settings."
            status in 500..599 -> "That means the provider had a temporary server-side problem. Retry in a moment or switch models."
            else -> ""
        }
    }
}
