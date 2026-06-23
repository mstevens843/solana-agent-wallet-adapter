package com.agentic.wallet.agent.runtime

import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private val ISO_FORMAT: ThreadLocal<SimpleDateFormat> = object : ThreadLocal<SimpleDateFormat>() {
    override fun initialValue(): SimpleDateFormat =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
}

internal fun isoTimestamp(epochMs: Long): String =
    ISO_FORMAT.get()!!.format(Date(epochMs))

enum class RuntimeMethod(val wire: String) {
    GENERATE_PLAN("generatePlan"),
    REVIEW_PLAN("reviewPlan"),
    ASK("ask"),
    LOCALIZE("localize"),
    // Native Plan-Connector chat: forwarded (non-streaming) to the paired
    // desktop's /bridge/ai/chat. Paired-bridge only — the on-device provider
    // executor rejects it (chat has no on-device plan/review framing).
    CHAT("chat");

    companion object {
        fun fromWire(value: String?): RuntimeMethod? =
            values().firstOrNull { it.wire == value }
    }
}

data class RuntimeRequest(
    val requestId: String,
    val method: RuntimeMethod,
    val payload: JSONObject,
    val enqueuedAtMs: Long,
)

sealed class RuntimeResult {
    abstract val requestId: String
    abstract val method: RuntimeMethod
    abstract val completedAtMs: Long

    data class Ok(
        override val requestId: String,
        override val method: RuntimeMethod,
        val data: JSONObject,
        override val completedAtMs: Long,
    ) : RuntimeResult()

    data class Failed(
        override val requestId: String,
        override val method: RuntimeMethod,
        val error: RuntimeError,
        override val completedAtMs: Long,
    ) : RuntimeResult()

    fun toJson(): JSONObject {
        val base = JSONObject()
            .put("requestId", requestId)
            .put("method", method.wire)
            .put("checkedAt", isoTimestamp(completedAtMs))
        return when (this) {
            is Ok -> base.put("ok", true).put("data", data)
            is Failed -> base.put("ok", false).put("error", error.toJson())
        }
    }
}
