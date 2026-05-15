package com.agentic.wallet.agent

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.agentic.wallet.BuildConfig
import com.agentic.wallet.NativeSecureStore
import com.agentic.wallet.agent.runtime.ProviderExecutor
import com.agentic.wallet.agent.runtime.RuntimeConfig
import com.agentic.wallet.agent.runtime.RuntimeError
import com.agentic.wallet.agent.runtime.RuntimeErrorCodes
import com.agentic.wallet.agent.runtime.RuntimeRegistry
import com.agentic.wallet.agent.runtime.RuntimeRequest
import com.agentic.wallet.agent.runtime.RuntimeResult
import com.agentic.wallet.agent.runtime.RuntimeState
import com.agentic.wallet.agent.runtime.RuntimeStatePersistence
import com.agentic.wallet.agent.runtime.isoTimestamp
import com.agentic.wallet.mwa.AgentMwaLog
import kotlinx.coroutines.runBlocking
import org.json.JSONException
import org.json.JSONObject

class AgentRuntimeController(
    private val context: Context,
    private val secureStore: NativeSecureStore,
) {
    private val persistence = RuntimeStatePersistence(context)

    init {
        RuntimeRegistry.hydrateFromPersistence(persistence)
    }

    fun statusJson(): JSONObject {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) return disabledStatusJson()

        val config = configJson()
        val configured = config != null
        val snapshot = RuntimeRegistry.currentSnapshot()
        val stateWire = snapshot.state.wire
        val message = when (stateWire) {
            RuntimeState.ERROR.wire -> snapshot.lastError?.message
                ?: "Android Device Agent runtime is in an error state."
            RuntimeState.RUNNING.wire -> "Android Device Agent runtime is running."
            RuntimeState.STARTING.wire -> "Android Device Agent runtime is starting."
            else -> "Android Device Agent runtime is stopped."
        }
        val json = JSONObject()
            .put("available", true)
            .put("enabled", true)
            .put("configured", configured)
            .put("state", stateWire)
            .put("runtime", "android-native")
            .put("provider", config?.optString("provider", "") ?: "")
            .put("apiFormat", RuntimeConfig.canonicalApiFormat(config?.optString("apiFormat", "") ?: ""))
            .put("baseUrl", config?.optString("baseUrl", "") ?: "")
            .put("model", config?.optString("model", "") ?: "")
            .put("message", message)
            .put("checkedAt", isoTimestamp(System.currentTimeMillis()))
        val walletAddress = config?.optString("walletAddress", "")?.takeIf { it.isNotBlank() }
        if (walletAddress != null) json.put("walletAddress", walletAddress)
        val lastError = snapshot.lastError
        json.put("lastError", lastError?.toJson() ?: JSONObject.NULL)
        val transitionAtMs = snapshot.lastTransitionAtMs
        json.put(
            "updatedAt",
            if (transitionAtMs > 0L) isoTimestamp(transitionAtMs) else JSONObject.NULL,
        )
        return json
    }

    fun configure(configJson: String): JSONObject {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) return statusJson()
        val config = parseConfig(configJson, "configure") ?: return statusJson()
        if (config.optBoolean("clear", false)) {
            clearConfigAndStop()
        } else {
            persistConfig(config)
        }
        return statusJson()
    }

    fun start(context: Context, configJson: String): JSONObject {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) return statusJson()
        val config = parseConfig(configJson, "start") ?: return statusJson()
        if (config.optBoolean("clear", false)) {
            clearConfigAndStop()
            return statusJson()
        }
        persistConfig(config)
        val parsed = RuntimeConfig.fromJson(config)
        val result = runBlocking { RuntimeRegistry.transitionStart(parsed, persistence) }
        when (result) {
            RuntimeState.RUNNING -> {
                try {
                    ContextCompat.startForegroundService(context, Intent(context, AgentRuntimeService::class.java))
                    AgentMwaLog.info("AgentRuntime", "start", "START", "device agent foreground service requested")
                } catch (err: Exception) {
                    AgentMwaLog.failure(
                        "AgentRuntime",
                        "start",
                        "FAIL",
                        "device agent foreground service failed",
                        err,
                    )
                    runBlocking {
                        RuntimeRegistry.recordError(
                            RuntimeError(
                                code = RuntimeErrorCodes.SERVICE_START_FAILED,
                                message = err.message ?: "Foreground service refused to start.",
                            ),
                            persistence,
                        )
                    }
                }
            }
            RuntimeState.ERROR -> AgentMwaLog.warn(
                "AgentRuntime",
                "start",
                "INVALID_CONFIG",
                "device agent start aborted; config invalid",
            )
            else -> Unit
        }
        return statusJson()
    }

    fun stop(context: Context): JSONObject {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) return statusJson()
        runBlocking { RuntimeRegistry.transitionStop(persistence) }
        context.stopService(Intent(context, AgentRuntimeService::class.java))
        AgentMwaLog.info("AgentRuntime", "stop", "DONE", "device agent foreground service stopped")
        return statusJson()
    }

    suspend fun submit(request: RuntimeRequest): RuntimeResult =
        RuntimeRegistry.submit(request)

    fun setProviderExecutor(executor: ProviderExecutor) {
        RuntimeRegistry.setExecutor(executor)
    }

    private fun parseConfig(configJson: String, callerTag: String): JSONObject? =
        try {
            JSONObject(configJson)
        } catch (err: JSONException) {
            AgentMwaLog.warn(
                "AgentRuntime",
                callerTag,
                "INVALID_PAYLOAD",
                "device agent config JSON parse failed",
                mapOf(
                    "class" to err.javaClass.simpleName,
                    "message" to (err.message ?: ""),
                ),
            )
            null
        }

    private fun persistConfig(config: JSONObject) {
        secureStore.set(NativeSecureStore.DEVICE_AGENT_CONFIG_KEY, config.toString())
        AgentMwaLog.info(
            "AgentRuntime",
            "configure",
            "DONE",
            "device agent config stored",
            mapOf(
                "provider" to config.optString("provider", ""),
                "apiFormat" to config.optString("apiFormat", ""),
                "model" to config.optString("model", ""),
                "hasKey" to config.optString("apiKey", "").isNotBlank(),
            ),
        )
    }

    private fun clearConfigAndStop() {
        secureStore.remove(NativeSecureStore.DEVICE_AGENT_CONFIG_KEY)
        runBlocking { RuntimeRegistry.transitionStop(persistence) }
        context.stopService(Intent(context, AgentRuntimeService::class.java))
        AgentMwaLog.info("AgentRuntime", "configure", "CLEAR", "device agent config cleared")
    }

    private fun disabledStatusJson(): JSONObject =
        JSONObject()
            .put("available", false)
            .put("enabled", false)
            .put("configured", false)
            .put("state", "unavailable")
            .put("runtime", "android-native")
            .put("provider", "")
            .put("apiFormat", "")
            .put("baseUrl", "")
            .put("model", "")
            .put("message", "Android Device Agent is disabled for this build.")
            .put("checkedAt", isoTimestamp(System.currentTimeMillis()))
            .put("lastError", JSONObject.NULL)
            .put("updatedAt", JSONObject.NULL)

    private fun configJson(): JSONObject? =
        secureStore.get(NativeSecureStore.DEVICE_AGENT_CONFIG_KEY)
            ?.takeIf { it.isNotBlank() }
            ?.let {
                try {
                    JSONObject(it)
                } catch (_: Exception) {
                    null
                }
            }
}
