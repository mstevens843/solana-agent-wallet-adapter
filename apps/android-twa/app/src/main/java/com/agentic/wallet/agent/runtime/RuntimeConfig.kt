package com.agentic.wallet.agent.runtime

import org.json.JSONObject

data class RuntimeConfig(
    val provider: String,
    val apiFormat: String,
    val model: String,
    val baseUrl: String?,
    val apiKey: String?,
    val walletAddress: String?,
) {
    fun validate(): RuntimeError? {
        if (provider.isBlank()) {
            return RuntimeError(
                code = RuntimeErrorCodes.INVALID_CONFIG,
                subcode = RuntimeConfigSubcodes.MISSING_PROVIDER,
                message = "Device Agent config is missing provider.",
            )
        }
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
    }
}
