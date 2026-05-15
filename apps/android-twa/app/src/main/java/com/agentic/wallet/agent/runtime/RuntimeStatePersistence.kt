package com.agentic.wallet.agent.runtime

import android.content.Context
import android.content.SharedPreferences

class RuntimeStatePersistence(context: Context) {
    private val prefs: SharedPreferences = context
        .applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    data class Snapshot(
        val state: RuntimeState,
        val error: RuntimeError?,
        val lastTransitionAtMs: Long,
    )

    fun load(): Snapshot {
        val state = RuntimeState.fromWire(prefs.getString(KEY_STATE, null))
        val code = prefs.getString(KEY_ERROR_CODE, null)?.takeIf { it.isNotBlank() }
        val error = if (code != null) {
            RuntimeError(
                code = code,
                subcode = prefs.getString(KEY_ERROR_SUBCODE, null)?.takeIf { it.isNotBlank() },
                message = prefs.getString(KEY_ERROR_MESSAGE, "") ?: "",
            )
        } else {
            null
        }
        val transitionAt = prefs.getLong(KEY_TRANSITION_AT, 0L)
        return Snapshot(state, error, transitionAt)
    }

    fun save(state: RuntimeState, error: RuntimeError?) {
        prefs.edit().apply {
            putString(KEY_STATE, state.wire)
            putLong(KEY_TRANSITION_AT, System.currentTimeMillis())
            if (error == null) {
                remove(KEY_ERROR_CODE)
                remove(KEY_ERROR_SUBCODE)
                remove(KEY_ERROR_MESSAGE)
            } else {
                putString(KEY_ERROR_CODE, error.code)
                if (error.subcode.isNullOrBlank()) {
                    remove(KEY_ERROR_SUBCODE)
                } else {
                    putString(KEY_ERROR_SUBCODE, error.subcode)
                }
                putString(KEY_ERROR_MESSAGE, error.message)
            }
            apply()
        }
    }

    companion object {
        private const val PREFS_NAME = "AgenticDeviceAgentRuntime"
        private const val KEY_STATE = "state"
        private const val KEY_ERROR_CODE = "lastErrorCode"
        private const val KEY_ERROR_SUBCODE = "lastErrorSubcode"
        private const val KEY_ERROR_MESSAGE = "lastErrorMessage"
        private const val KEY_TRANSITION_AT = "lastTransitionAtMs"
    }
}
