package com.agentic.wallet.agent

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.agentic.wallet.BuildConfig
import com.agentic.wallet.NativeSecureStore
import com.agentic.wallet.agent.provider.DefaultHttpExecutor
import com.agentic.wallet.agent.provider.ProviderErrorCodes
import com.agentic.wallet.agent.provider.ProviderHttp
import com.agentic.wallet.agent.provider.ProviderHttpException
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
        val runtimeConfig = RuntimeConfig.fromJson(config)
        val configured = runtimeConfig?.validate() == null && runtimeConfig != null
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
        // Advertise on-device chat-agent capabilities so JS can feature-detect this
        // binary. `chatComplete` gates the loop vs the planner; `chatCompleteGeneric`
        // means `complete` accepts the JS url+headers fetch mode; `chatCompleteStream`
        // is false until native token streaming ships (a future build).
        json.put(
            "capabilities",
            JSONObject()
                .put("chatComplete", true)
                .put("chatCompleteGeneric", true)
                .put("chatCompleteStream", true)
                .put("version", "1")
                .put("supportedTransports", org.json.JSONArray(listOf("openai-compatible", "anthropic-messages", "gemini-native"))),
        )
        return json
    }

    fun configure(configJson: String): JSONObject {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) return statusJson()
        val config = parseConfig(configJson, "configure") ?: return statusJson()
        if (config.optBoolean("clear", false)) {
            clearConfigAndStop()
        } else {
            persistConfig(resolveConfigForPersistence(config))
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
        val resolved = resolveStartConfig(config)
        if (resolved.persist && resolved.config != null) {
            persistConfig(resolved.config)
        }
        val parsed = RuntimeConfig.fromJson(resolved.config)
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

    // On-device chat-agent completion. The JS chat loop built the full provider
    // request `body`; native injects the stored key and POSTs it, returning the RAW
    // provider response `{ httpStatus, body }` for JS to parse. The key never leaves
    // native. Two modes:
    //  - Transport mode (current): JS sends `transport`; native builds url+headers
    //    from its own config (no URL from JS).
    //  - Generic mode (future-proof): JS sends `url` + `headers` + `keyHeader`; native
    //    validates the url host against its configured provider host (anti-exfiltration)
    //    and injects the key — so future providers/endpoints/headers ship via Render
    //    with no native build.
    suspend fun complete(payload: JSONObject): JSONObject {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Android Device Agent is disabled for this build.")
        }
        val config = RuntimeConfig.fromJson(configJson())
            ?: throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Device Agent is not configured.")
        val body = payload.optJSONObject("body")?.toString()
            ?: throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Device Agent complete payload is missing the request body.")
        val apiKey = (config.apiKey ?: "").trim()
        ProviderHttp.assertApiKeyHeaderSafe(apiKey)
        // Chat tool-using turns can run long; allow JS to tune the read timeout (clamped).
        val timeoutMs = payload.optInt("timeoutMs", 120_000).coerceIn(5_000, 300_000)
        val http = DefaultHttpExecutor(readTimeoutMs = timeoutMs)
        val jsUrl = payload.optString("url", "").trim()
        val endpoint = if (jsUrl.isNotEmpty()) {
            assertCompleteUrlHostAllowed(jsUrl, config)
            CompleteEndpoint(jsUrl, injectKeyHeader(jsonToStringMap(payload.optJSONObject("headers")), payload.optJSONObject("keyHeader"), apiKey))
        } else {
            completeEndpoint(payload.optString("transport", "").trim(), config, apiKey)
        }
        val response = http.postJson(endpoint.url, endpoint.headers, body)
        return JSONObject()
            .put("httpStatus", response.status)
            .put("body", response.body)
    }

    // Streaming chat completion: identical setup to [complete], but the provider SSE
    // body is relayed to JS incrementally via [onChunk] (JS rebuilds a Response +
    // reuses its parser). Resolves with {httpStatus, body?} at the end (body only on a
    // non-2xx error). The key stays native. Gated by capabilities.chatCompleteStream.
    suspend fun completeStream(payload: JSONObject, onChunk: (String) -> Unit): JSONObject {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Android Device Agent is disabled for this build.")
        }
        val config = RuntimeConfig.fromJson(configJson())
            ?: throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Device Agent is not configured.")
        val body = payload.optJSONObject("body")?.toString()
            ?: throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Device Agent completeStream payload is missing the request body.")
        val apiKey = (config.apiKey ?: "").trim()
        ProviderHttp.assertApiKeyHeaderSafe(apiKey)
        val timeoutMs = payload.optInt("timeoutMs", 120_000).coerceIn(5_000, 300_000)
        val http = DefaultHttpExecutor(readTimeoutMs = timeoutMs)
        val jsUrl = payload.optString("url", "").trim()
        val endpoint = if (jsUrl.isNotEmpty()) {
            assertCompleteUrlHostAllowed(jsUrl, config)
            CompleteEndpoint(jsUrl, injectKeyHeader(jsonToStringMap(payload.optJSONObject("headers")), payload.optJSONObject("keyHeader"), apiKey))
        } else {
            completeStreamEndpoint(payload.optString("transport", "").trim(), config, apiKey)
        }
        val response = http.postJsonStreaming(endpoint.url, endpoint.headers, body, onChunk)
        val result = JSONObject().put("httpStatus", response.status)
        if (response.status !in 200..299 && response.body.isNotEmpty()) result.put("body", response.body)
        return result
    }

    private data class CompleteEndpoint(val url: String, val headers: Map<String, String>)

    private fun jsonToStringMap(obj: JSONObject?): Map<String, String> {
        if (obj == null) return emptyMap()
        val out = LinkedHashMap<String, String>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = obj.opt(key)
            if (value is String) out[key] = value
        }
        return out
    }

    private fun injectKeyHeader(headers: Map<String, String>, keyHeader: JSONObject?, apiKey: String): Map<String, String> {
        val name = keyHeader?.optString("name", "")?.trim().orEmpty().ifEmpty { "Authorization" }
        val scheme = keyHeader?.optString("scheme", "")?.trim()?.lowercase().orEmpty()
        val value = if (scheme == "bearer") "Bearer $apiKey" else apiKey
        return headers + (name to value)
    }

    // Generic-mode guard: the JS-supplied URL must be https and its host must match one
    // of the hosts derivable from the stored config baseUrl — so a compromised WebView
    // can never point the stored key at an attacker host.
    private fun assertCompleteUrlHostAllowed(url: String, config: RuntimeConfig) {
        if (!url.startsWith("https://", ignoreCase = true)) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Device Agent completion URL must use https://.")
        }
        val host = runCatching { java.net.URI(url).host?.lowercase() }.getOrNull()
            ?: throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Device Agent completion URL is invalid.")
        val allowed = listOf(
            ProviderHttp.normalizeBaseUrl(config.baseUrl, "openai-compatible"),
            ProviderHttp.normalizeBaseUrl(config.baseUrl, "anthropic"),
            ProviderHttp.normalizeNativeBaseUrl(config.baseUrl),
        ).mapNotNull { runCatching { java.net.URI(it).host?.lowercase() }.getOrNull() }.toSet()
        if (host !in allowed) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Device Agent completion URL host is not allowed for this provider.")
        }
    }

    private fun completeEndpoint(transport: String, config: RuntimeConfig, apiKey: String): CompleteEndpoint {
        val openRouter = ProviderHttp.isOpenRouterConfig(config.provider, config.baseUrl)
        return when (transport) {
            "anthropic-messages" -> {
                val format = if (openRouter) "openai-compatible" else "anthropic"
                val base = ProviderHttp.normalizeBaseUrl(config.baseUrl, format)
                val headers = if (openRouter) {
                    mapOf("Authorization" to "Bearer $apiKey", "X-OpenRouter-Metadata" to "enabled") +
                        ProviderHttp.openRouterAttributionHeaders(true)
                } else {
                    mapOf("x-api-key" to apiKey, "anthropic-version" to "2023-06-01")
                }
                CompleteEndpoint("$base/messages", headers)
            }
            "gemini-native" -> {
                val base = ProviderHttp.normalizeNativeBaseUrl(config.baseUrl)
                val encodedModel = java.net.URLEncoder.encode(config.model.trim(), "UTF-8")
                CompleteEndpoint("$base/models/$encodedModel:generateContent", mapOf("x-goog-api-key" to apiKey))
            }
            else -> {
                // openai-compatible (and OpenAI / OpenRouter non-anthropic) → /chat/completions.
                val base = ProviderHttp.normalizeBaseUrl(config.baseUrl, "openai-compatible")
                val headers = mapOf("Authorization" to "Bearer $apiKey") +
                    ProviderHttp.openRouterAttributionHeaders(openRouter)
                CompleteEndpoint("$base/chat/completions", headers)
            }
        }
    }

    // Streaming endpoints. OpenAI/Anthropic stream on the SAME URL as non-streaming
    // (only the body's `stream:true` differs), but Gemini streams on a DIFFERENT URL
    // (`:streamGenerateContent?alt=sse` vs `:generateContent`) — without this, native
    // Gemini streaming would POST to the non-streaming endpoint and get one JSON blob
    // instead of an SSE stream, so the JS parser would see no frames.
    private fun completeStreamEndpoint(transport: String, config: RuntimeConfig, apiKey: String): CompleteEndpoint {
        if (transport == "gemini-native") {
            val base = ProviderHttp.normalizeNativeBaseUrl(config.baseUrl)
            val encodedModel = java.net.URLEncoder.encode(config.model.trim(), "UTF-8")
            return CompleteEndpoint("$base/models/$encodedModel:streamGenerateContent?alt=sse", mapOf("x-goog-api-key" to apiKey))
        }
        return completeEndpoint(transport, config, apiKey)
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

    private data class ResolvedConfig(val config: JSONObject?, val persist: Boolean)

    private fun resolveConfigForPersistence(config: JSONObject): JSONObject {
        val stored = configJson()
        if (stored != null && shouldMergeWithStoredSecret(config)) {
            return mergeStoredSecretConfig(stored, config)
        }
        return config
    }

    private fun resolveStartConfig(config: JSONObject): ResolvedConfig {
        val stored = configJson()
        if (RuntimeConfig.fromJson(config) == null) {
            return ResolvedConfig(stored, false)
        }
        if (stored != null && shouldMergeWithStoredSecret(config)) {
            return ResolvedConfig(mergeStoredSecretConfig(stored, config), true)
        }
        return ResolvedConfig(config, true)
    }

    private fun shouldMergeWithStoredSecret(config: JSONObject): Boolean {
        val parsed = RuntimeConfig.fromJson(config) ?: return false
        if (parsed.isPairedBridge()) return false
        return parsed.apiKey.isNullOrBlank()
    }

    private fun mergeStoredSecretConfig(stored: JSONObject, incoming: JSONObject): JSONObject {
        val merged = JSONObject(stored.toString())
        for (key in listOf("provider", "apiFormat", "baseUrl", "model", "walletAddress")) {
            val value = incoming.optString(key, "").trim()
            if (value.isNotBlank()) {
                merged.put(key, value)
            }
        }
        return merged
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
