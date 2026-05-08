package com.agentic.wallet.mwa

import android.util.Log
import com.agentic.wallet.BuildConfig
import java.security.MessageDigest

object AgentMwaLog {
    private const val TAG = "AgentAndroidMWA"
    private const val CHUNK_TAG = "AgentAndroidMWA_CHUNK"
    private const val LOG_CHUNK_SIZE = 3_200
    private const val RELEASE_VALUE_LIMIT = 240

    fun info(
        component: String,
        method: String,
        step: String,
        message: String,
        metadata: Map<String, Any?> = emptyMap(),
    ) {
        emit(Log.INFO, line(component, method, step, "INFO", message, metadata))
    }

    fun warn(
        component: String,
        method: String,
        step: String,
        message: String,
        metadata: Map<String, Any?> = emptyMap(),
    ) {
        emit(Log.WARN, line(component, method, step, "FAIL", message, metadata))
    }

    fun failure(
        component: String,
        method: String,
        step: String,
        message: String,
        err: Throwable,
        metadata: Map<String, Any?> = emptyMap(),
    ) {
        warn(component, method, step, message, metadata + errorMetadata(err))
    }

    fun debug(
        component: String,
        method: String,
        step: String,
        message: String,
        metadata: Map<String, Any?> = emptyMap(),
    ) {
        if (BuildConfig.DEBUG) {
            emit(Log.INFO, line(component, method, step, "INFO", message, metadata))
        }
    }

    fun bytesMetadata(prefix: String, bytes: ByteArray, includeUtf8: Boolean = false): Map<String, Any?> {
        val metadata = mutableMapOf<String, Any?>(
            "${prefix}Bytes" to bytes.size,
            "${prefix}Sha256_8" to sha256First8(bytes),
            "${prefix}Hex" to hex(bytes, if (BuildConfig.DEBUG || bytes.size <= 40) bytes.size else 40),
        )
        if (includeUtf8) {
            metadata["${prefix}Utf8"] = bytes.toString(Charsets.UTF_8)
        }
        return metadata
    }

    fun transactionMetadata(prefix: String, bytes: ByteArray): Map<String, Any?> {
        val metadata = mutableMapOf<String, Any?>(
            "${prefix}Bytes" to bytes.size,
            "${prefix}Sha256_8" to sha256First8(bytes),
            "${prefix}HexPrefix" to hex(bytes, if (BuildConfig.DEBUG) 80 else 24),
        )
        if (BuildConfig.DEBUG) {
            metadata["${prefix}Hex"] = hex(bytes, bytes.size)
        }
        return metadata
    }

    fun errorMetadata(err: Throwable?): Map<String, Any?> =
        if (err == null) {
            emptyMap()
        } else {
            mapOf(
                "class" to err.javaClass.simpleName,
                "message" to err.message,
                "stack" to err.stackTraceToString(),
                "causeClass" to err.cause?.javaClass?.simpleName,
                "causeMessage" to err.cause?.message,
            )
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
        val redacted = redactUrl(raw)
        return if (BuildConfig.DEBUG) redacted else redacted.take(RELEASE_VALUE_LIMIT)
    }

    private fun redactUrl(value: String): String =
        value.replace(Regex("([?&][^=&]*(?:api[-_]?key|token|secret)[^=&]*=)[^&\\s]+", RegexOption.IGNORE_CASE), "$1[redacted]")

    private fun quote(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

    private fun emit(priority: Int, line: String) {
        if (line.length <= LOG_CHUNK_SIZE) {
            Log.println(priority, TAG, line)
            return
        }
        val parts = (line.length + LOG_CHUNK_SIZE - 1) / LOG_CHUNK_SIZE
        Log.println(
            priority,
            TAG,
            "[AgentAndroidMWA] chunkedLine length=${quote(line.length.toString())} sha256_8=${quote(sha256First8(line.toByteArray(Charsets.UTF_8)))} parts=${quote(parts.toString())}",
        )
        line.chunked(LOG_CHUNK_SIZE).forEachIndexed { index, chunk ->
            Log.println(priority, CHUNK_TAG, "part=${quote("${index + 1}/$parts")} chunk=${quote(chunk)}")
        }
    }

    private fun sha256First8(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes), 8)

    private fun hex(bytes: ByteArray, count: Int): String =
        bytes.take(count).joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
