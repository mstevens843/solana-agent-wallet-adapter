package com.agentic.wallet.mwa

import android.util.Log

object AgentMwaLog {
    private const val TAG = "AgentAndroidMWA"

    fun info(
        component: String,
        method: String,
        step: String,
        message: String,
        metadata: Map<String, Any?> = emptyMap(),
    ) {
        Log.i(TAG, line(component, method, step, "INFO", message, metadata))
    }

    fun warn(
        component: String,
        method: String,
        step: String,
        message: String,
        metadata: Map<String, Any?> = emptyMap(),
    ) {
        Log.w(TAG, line(component, method, step, "FAIL", message, metadata))
    }

    private fun line(
        component: String,
        method: String,
        step: String,
        phase: String,
        message: String,
        metadata: Map<String, Any?>,
    ): String {
        val suffix = metadata.toSortedMap().entries.joinToString(" ") { (key, value) ->
            "${sanitizeKey(key)}=${quote(sanitizeValue(key, value))}"
        }
        return "[AgentAndroidMWA] [$component] $method | $step phase=$phase message=${quote(message)}${if (suffix.isBlank()) "" else " $suffix"}"
    }

    private fun sanitizeKey(key: String): String = key.replace(Regex("[^A-Za-z0-9_.-]"), "_")

    private fun sanitizeValue(key: String, value: Any?): String {
        val normalized = key.lowercase()
        if (
            normalized.contains("token") ||
            normalized.contains("secret") ||
            normalized.contains("private") ||
            normalized.contains("ciphertext") ||
            normalized.contains("plaintext")
        ) {
            return "[redacted]"
        }
        val raw = value?.toString() ?: ""
        return redactUrl(raw).take(240)
    }

    private fun redactUrl(value: String): String =
        value.replace(Regex("([?&][^=&]*(?:api[-_]?key|token|secret)[^=&]*=)[^&\\s]+", RegexOption.IGNORE_CASE), "$1[redacted]")

    private fun quote(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""
}
