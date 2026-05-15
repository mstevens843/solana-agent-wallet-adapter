package com.agentic.wallet.agent.runtime

import org.json.JSONObject

enum class RuntimeState(val wire: String) {
    STOPPED("stopped"),
    STARTING("starting"),
    RUNNING("running"),
    ERROR("error");

    companion object {
        fun fromWire(value: String?): RuntimeState =
            values().firstOrNull { it.wire == value } ?: STOPPED
    }
}

data class RuntimeError(
    val code: String,
    val subcode: String? = null,
    val message: String,
) {
    fun toJson(): JSONObject {
        val json = JSONObject()
            .put("code", code)
            .put("message", message)
        if (!subcode.isNullOrBlank()) {
            json.put("subcode", subcode)
        }
        return json
    }
}

object RuntimeErrorCodes {
    const val INVALID_CONFIG = "invalid_config"
    const val INVALID_PAYLOAD = "invalid_payload"
    const val RUNTIME_DISABLED = "runtime_disabled"
    const val RUNTIME_NOT_RUNNING = "runtime_not_running"
    const val RUNTIME_BUSY = "runtime_busy"
    const val RUNTIME_CANCELED = "runtime_canceled"
    const val RUNTIME_INTERNAL = "runtime_internal"
    const val UNSUPPORTED_METHOD = "unsupported_method"
    const val PROVIDER_UNAVAILABLE = "provider_unavailable"
    const val PROVIDER_FAILED = "provider_failed"
    const val SERVICE_START_FAILED = "service_start_failed"
}

object RuntimeConfigSubcodes {
    const val MISSING_PROVIDER = "missing_provider"
    const val MISSING_MODEL = "missing_model"
    const val MISSING_API_KEY = "missing_api_key"
    const val UNSUPPORTED_FORMAT = "unsupported_format"
}
