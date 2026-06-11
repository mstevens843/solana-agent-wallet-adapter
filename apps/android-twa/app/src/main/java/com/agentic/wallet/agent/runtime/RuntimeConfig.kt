package com.agentic.wallet.agent.runtime

import java.net.URI
import org.json.JSONObject

data class RuntimeConfig(
    val provider: String,
    val apiFormat: String,
    val model: String,
    val baseUrl: String?,
    val apiKey: String?,
    val walletAddress: String?,
) {
    /** The paired-bridge ("use your plan from your computer") path: inference runs on the user's
     *  own desktop connector, so this config carries NO apiKey/model/apiFormat of its own — the
     *  device bearer + relay live in NativeSecureStore (BridgePairingStore). */
    fun isPairedBridge(): Boolean = provider.trim().equals(PAIRED_BRIDGE_PROVIDER, ignoreCase = true)

    fun validate(): RuntimeError? {
        if (provider.isBlank()) {
            return RuntimeError(
                code = RuntimeErrorCodes.INVALID_CONFIG,
                subcode = RuntimeConfigSubcodes.MISSING_PROVIDER,
                message = "Device Agent config is missing provider.",
            )
        }
        // Paired-bridge skips the API-key/model/format checks below — its credentials live on the
        // paired desktop, not in this config.
        if (isPairedBridge()) return null
        if (apiFormat.isBlank() || apiFormat !in SUPPORTED_API_FORMATS) {
            return RuntimeError(
                code = RuntimeErrorCodes.INVALID_CONFIG,
                subcode = RuntimeConfigSubcodes.UNSUPPORTED_FORMAT,
                message = "Device Agent apiFormat must be one of ${SUPPORTED_API_FORMATS.joinToString(", ")}.",
            )
        }
        if (model.isBlank()) {
            return RuntimeError(
                code = RuntimeErrorCodes.INVALID_CONFIG,
                subcode = RuntimeConfigSubcodes.MISSING_MODEL,
                message = "Device Agent config is missing model.",
            )
        }
        if (apiKey.isNullOrBlank()) {
            return RuntimeError(
                code = RuntimeErrorCodes.INVALID_CONFIG,
                subcode = RuntimeConfigSubcodes.MISSING_API_KEY,
                message = "Device Agent config is missing apiKey.",
            )
        }
        customOpenAiCompatibleBaseUrlError(provider, baseUrl)?.let { message ->
            return RuntimeError(
                code = RuntimeErrorCodes.INVALID_CONFIG,
                subcode = RuntimeConfigSubcodes.UNSUPPORTED_FORMAT,
                message = message,
            )
        }
        return null
    }

    fun redactedSummary(): Map<String, Any?> = mapOf(
        "provider" to provider,
        "apiFormat" to apiFormat,
        "model" to model,
        "baseUrl" to (baseUrl ?: ""),
        "hasKey" to !apiKey.isNullOrBlank(),
        "walletShort" to walletAddress?.take(4),
    )

    fun redactedJson(): JSONObject = JSONObject()
        .put("provider", provider)
        .put("apiFormat", apiFormat)
        .put("model", model)
        .put("baseUrl", baseUrl ?: "")

    companion object {
        const val PAIRED_BRIDGE_PROVIDER = "paired-bridge"
        val SUPPORTED_API_FORMATS = setOf("openai-compatible", "anthropic")

        fun canonicalApiFormat(value: String): String =
            when (value.trim()) {
                "openai" -> "openai-compatible"
                else -> value.trim()
            }

        fun fromJson(json: JSONObject?): RuntimeConfig? {
            if (json == null) return null
            val provider = json.optString("provider", "").trim()
            val apiFormat = canonicalApiFormat(json.optString("apiFormat", ""))
            val model = json.optString("model", "").trim()
            val baseUrl = json.optString("baseUrl", "").trim().takeIf { it.isNotBlank() }
            val apiKey = json.optString("apiKey", "").takeIf { it.isNotBlank() }
            val walletAddress = json.optString("walletAddress", "").trim().takeIf { it.isNotBlank() }
            if (provider.isEmpty() && apiFormat.isEmpty() && model.isEmpty() && apiKey == null) {
                return null
            }
            return RuntimeConfig(
                provider = provider,
                apiFormat = apiFormat,
                model = model,
                baseUrl = baseUrl,
                apiKey = apiKey,
                walletAddress = walletAddress,
            )
        }

        private fun customOpenAiCompatibleBaseUrlError(provider: String, baseUrl: String?): String? {
            if (!provider.trim().equals("custom-openai-compatible", ignoreCase = true)) return null
            val trimmed = baseUrl?.trim().orEmpty()
            if (trimmed.isEmpty()) return "Custom OpenAI-compatible gateway URL is required."
            val uri = try {
                URI(trimmed)
            } catch (_: Throwable) {
                return "Custom OpenAI-compatible gateway URL must be a valid https:// URL."
            }
            if (uri.scheme?.equals("https", ignoreCase = true) != true) {
                return "Custom OpenAI-compatible gateway URL must use https://."
            }
            val host = uri.host?.lowercase()
                ?: return "Custom OpenAI-compatible gateway URL must be a valid https:// URL."
            val path = uri.path.orEmpty().lowercase()
            if (host == "openrouter.ai" || host.endsWith(".openrouter.ai")) {
                return "Use the OpenRouter preset for deterministic agent review routing; do not enter openrouter.ai under Custom OpenAI-compatible."
            }
            if (host == "api.anthropic.com" || host.endsWith(".anthropic.com")) {
                return "Use the Claude / Anthropic preset for Anthropic URLs; Custom OpenAI-compatible expects an endpoint that implements OpenAI-compatible chat completions."
            }
            if ((host == "generativelanguage.googleapis.com" || host.endsWith(".generativelanguage.googleapis.com")) &&
                !Regex("(^|/)openai(/|$)", RegexOption.IGNORE_CASE).containsMatchIn(path)
            ) {
                return "Use the Gemini preset for native Gemini URLs; Custom OpenAI-compatible expects an OpenAI-compatible /openai endpoint."
            }
            return null
        }
    }
}
