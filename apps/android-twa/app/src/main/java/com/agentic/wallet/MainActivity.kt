package com.agentic.wallet

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.lifecycle.lifecycleScope
import com.agentic.wallet.agent.AgentRuntimeController
import com.agentic.wallet.agent.provider.DeviceAgentProviderExecutor
import com.agentic.wallet.agent.runtime.RuntimeMethod
import com.agentic.wallet.agent.runtime.RuntimeRequest
import com.agentic.wallet.agent.runtime.RuntimeResult
import com.agentic.wallet.mwa.AgentCluster
import com.agentic.wallet.mwa.AgentMwaAuthRecord
import com.agentic.wallet.mwa.AgentMwaBridgeRequest
import com.agentic.wallet.mwa.AgentMwaIdentity
import com.agentic.wallet.mwa.AgentMwaLog
import com.agentic.wallet.mwa.AgentMwaSigningResult
import com.agentic.wallet.mwa.MwaController
import com.agentic.wallet.mwa.MwaOperationException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONException
import org.json.JSONObject
import java.io.FileNotFoundException
import java.security.MessageDigest

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var mwaController: MwaController
    private lateinit var secureStore: NativeSecureStore
    private lateinit var agentRuntimeController: AgentRuntimeController

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mwaController = MwaController(applicationContext, defaultMwaIdentity())
        secureStore = NativeSecureStore(applicationContext)
        agentRuntimeController = AgentRuntimeController(applicationContext, secureStore)
        if (BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) {
            agentRuntimeController.setProviderExecutor(DeviceAgentProviderExecutor())
        }
        AgentMwaLog.info(
            "MainActivity",
            "onCreate",
            "START",
            "native activity launched",
            mapOf(
                "mode" to "app_native",
                "exampleTab" to BuildConfig.AGENTIC_ANDROID_SHOW_EXAMPLE_TAB,
                "webFallbackEnabled" to BuildConfig.AGENTIC_ANDROID_ENABLE_WEB_FALLBACK,
                "lanBridgeEnabled" to BuildConfig.AGENTIC_ANDROID_ALLOW_LAN_BRIDGE,
                "deviceAgentEnabled" to BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT,
                "cloudApiBaseUrl" to BuildConfig.AGENTIC_ANDROID_CLOUD_API_BASE_URL,
            ),
        )

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(LOCAL_APP_HOST)
            .addPathHandler("/", BundledAppPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(android.graphics.Color.rgb(5, 7, 6))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            if (BuildConfig.AGENTIC_ANDROID_ALLOW_LAN_BRIDGE) {
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            }
            addJavascriptInterface(AndroidBridge(this@MainActivity), "AgenticAndroid")
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                    val level = consoleMessage.messageLevel()
                    val metadata = mapOf(
                        "level" to level,
                        "line" to consoleMessage.lineNumber(),
                        "source" to consoleMessage.sourceId(),
                    )
                    if (level == ConsoleMessage.MessageLevel.ERROR) {
                        AgentMwaLog.warn(
                            "MainActivity",
                            "console",
                            "WEBVIEW_CONSOLE",
                            consoleMessage.message(),
                            metadata,
                        )
                    } else {
                        AgentMwaLog.info(
                            "MainActivity",
                            "console",
                            "WEBVIEW_CONSOLE",
                            consoleMessage.message(),
                            metadata,
                        )
                    }
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    AgentMwaLog.warn(
                        "MainActivity",
                        "onReceivedError",
                        "WEBVIEW_RESOURCE_ERROR",
                        error.description?.toString() ?: "web resource load failed",
                        mapOf(
                            "code" to error.errorCode,
                            "url" to request.url,
                            "mainFrame" to request.isForMainFrame,
                        ),
                    )
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    errorResponse: WebResourceResponse,
                ) {
                    AgentMwaLog.warn(
                        "MainActivity",
                        "onReceivedHttpError",
                        "WEBVIEW_HTTP_ERROR",
                        errorResponse.reasonPhrase ?: "web resource http error",
                        mapOf(
                            "status" to errorResponse.statusCode,
                            "url" to request.url,
                            "mainFrame" to request.isForMainFrame,
                        ),
                    )
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val uri = request.url ?: return false
                    if (uri.scheme == "https" && uri.host == LOCAL_APP_HOST) return false
                    openExternal(uri)
                    return true
                }
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        setContentView(webView)
        applySystemBarInsets(webView)

        if (savedInstanceState == null) {
            webView.loadUrl(LOCAL_APP_START_URL)
        }
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
            return
        }
        super.onBackPressed()
    }

    private fun defaultMwaIdentity(): AgentMwaIdentity {
        val launch = Uri.parse(BuildConfig.AGENTIC_LAUNCH_URL)
        val scheme = launch.scheme ?: "https"
        val host = launch.host ?: "agenticwalletadapter.com"
        val origin = "$scheme://$host${if (launch.port > 0) ":${launch.port}" else ""}"
        return AgentMwaIdentity(
            name = "Agentic",
            uri = origin,
            iconUri = "$origin/favicon.ico",
        )
    }

    private fun dispatchDeviceAgentResolve(requestId: String, envelope: JSONObject) {
        if (isDestroyed) {
            AgentMwaLog.warn(
                "MainActivity",
                "dispatchDeviceAgentResolve",
                "ACTIVITY_DESTROYED",
                "skipped Device Agent resolve on destroyed activity",
                mapOf("requestId" to requestId),
            )
            return
        }
        val js =
            "(function(){var b=window.__agenticAndroidDeviceAgentBridge;if(b&&b.resolve){b.resolve(${JSONObject.quote(requestId)},$envelope);}})();"
        AgentMwaLog.info(
            "MainActivity",
            "dispatchDeviceAgentResolve",
            "START",
            "evaluating Device Agent resolve callback",
            mapOf(
                "requestId" to requestId,
                "ok" to envelope.optBoolean("ok", false),
                "envelopeBytes" to envelope.toString().toByteArray(Charsets.UTF_8).size,
                "envelope" to if (BuildConfig.DEBUG) envelope else "[debug-only]",
            ),
        )
        webView.evaluateJavascript(js) { result ->
            AgentMwaLog.info(
                "MainActivity",
                "dispatchDeviceAgentResolve",
                "DONE",
                "Device Agent resolve callback evaluated",
                mapOf("requestId" to requestId, "evalResult" to result.orEmpty()),
            )
        }
    }

    private fun dispatchDeviceAgentReject(requestId: String, code: String, message: String) {
        if (isDestroyed) {
            AgentMwaLog.warn(
                "MainActivity",
                "dispatchDeviceAgentReject",
                "ACTIVITY_DESTROYED",
                "skipped Device Agent reject on destroyed activity",
                mapOf("requestId" to requestId, "code" to code),
            )
            return
        }
        val errorPayload = JSONObject().put("code", code).put("message", message)
        val js =
            "(function(){var b=window.__agenticAndroidDeviceAgentBridge;if(b&&b.reject){b.reject(${JSONObject.quote(requestId)},$errorPayload);}})();"
        AgentMwaLog.warn(
            "MainActivity",
            "dispatchDeviceAgentReject",
            "START",
            "evaluating Device Agent reject callback (envelope construction failed)",
            mapOf("requestId" to requestId, "code" to code, "message" to message),
        )
        webView.evaluateJavascript(js) { result ->
            AgentMwaLog.info(
                "MainActivity",
                "dispatchDeviceAgentReject",
                "DONE",
                "Device Agent reject callback evaluated",
                mapOf("requestId" to requestId, "evalResult" to result.orEmpty()),
            )
        }
    }

    private fun resolveMwaRequest(requestId: String, payload: JSONObject) {
        AgentMwaLog.info(
            "MainActivity",
            "resolveMwaRequest",
            "START",
            "dispatching Android MWA resolve callback",
            mapOf("requestId" to requestId, "payload" to if (BuildConfig.DEBUG) payload else "[debug-only]", "payloadBytes" to payload.toString().toByteArray(Charsets.UTF_8).size),
        )
        dispatchMwaCallback("resolve", requestId, payload)
    }

    private fun rejectMwaRequest(requestId: String, err: Throwable) {
        val code = if (err is MwaOperationException) err.code else "WALLET_ERROR"
        val message = err.message ?: err.javaClass.simpleName
        val payload = JSONObject()
            .put("code", code)
            .put("message", message)
        AgentMwaLog.failure(
            "MainActivity",
            "rejectMwaRequest",
            "START",
            "dispatching Android MWA reject callback",
            err,
            mapOf("requestId" to requestId, "code" to code, "payload" to if (BuildConfig.DEBUG) payload else "[debug-only]"),
        )
        dispatchMwaCallback("reject", requestId, payload)
    }

    private fun dispatchMwaCallback(callback: String, requestId: String, payload: JSONObject) {
        val js =
            "(function(){var b=window.__agenticAndroidMwaBridge;if(b&&b.$callback){b.$callback(${JSONObject.quote(requestId)},$payload);}})();"
        AgentMwaLog.info(
            "MainActivity",
            "dispatchMwaCallback",
            "START",
            "evaluating WebView callback JavaScript",
            mapOf("callback" to callback, "requestId" to requestId, "payload" to if (BuildConfig.DEBUG) payload else "[debug-only]", "js" to if (BuildConfig.DEBUG) js else "[debug-only]"),
        )
        webView.evaluateJavascript(js) { result ->
            AgentMwaLog.info(
                "MainActivity",
                "dispatchMwaCallback",
                "DONE",
                "WebView callback JavaScript evaluated",
                mapOf("callback" to callback, "requestId" to requestId, "evalResult" to result.orEmpty()),
            )
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            AgentMwaLog.warn(
                "MainActivity",
                "openExternal",
                "FAIL",
                "no activity available for external uri",
                mapOf("scheme" to uri.scheme, "host" to uri.host),
            )
        }
    }

    private fun applySystemBarInsets(view: WebView) {
        ViewCompat.setOnApplyWindowInsetsListener(view) { target, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            target.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }

    private class AndroidBridge(private val activity: MainActivity) {
        @JavascriptInterface
        fun openMwaExample() {
            val intent = Intent(activity, MwaExampleActivity::class.java)
            activity.startActivity(intent)
        }

        @JavascriptInterface
        fun isExampleTabEnabled(): Boolean = BuildConfig.AGENTIC_ANDROID_SHOW_EXAMPLE_TAB

        @JavascriptInterface
        fun isDebugBuild(): Boolean = BuildConfig.DEBUG

        @JavascriptInterface
        fun secureGet(key: String): String {
            validateSecureStoreRequest(key)
            return activity.secureStore.get(key).orEmpty()
        }

        @JavascriptInterface
        fun secureSet(key: String, value: String): Boolean {
            validateSecureStoreRequest(key, value)
            activity.secureStore.set(key, value)
            return true
        }

        @JavascriptInterface
        fun secureDelete(key: String): Boolean {
            validateSecureStoreRequest(key)
            activity.secureStore.remove(key)
            return true
        }

        @JavascriptInterface
        fun deviceAgentStatus(): String =
            activity.agentRuntimeController.statusJson().toString()

        @JavascriptInterface
        fun deviceAgentConfigure(configJson: String): String {
            validateDeviceAgentPayload(configJson)
            return activity.agentRuntimeController.configure(configJson).toString()
        }

        @JavascriptInterface
        fun deviceAgentStart(configJson: String): String {
            validateDeviceAgentPayload(configJson)
            return activity.agentRuntimeController.start(activity, configJson).toString()
        }

        @JavascriptInterface
        fun deviceAgentStop(): String =
            activity.agentRuntimeController.stop(activity).toString()

        /**
         * Async Device Agent bridge entry point. Mirrors the MWA pattern but with a
         * stricter contract: every callable response — success or operational failure —
         * is dispatched via the JS `resolve` callback as a DeviceAgentResponseEnvelope
         * (`{ok:true, status, result?}` or `{ok:false, status, error}`). The JS `reject`
         * callback is reserved for envelope-construction catastrophes (validation
         * exceptions before the controller is reachable, JSON serialization failures);
         * it carries only `{code, message}` and discards status.
         *
         * Reason: Phase 4's `deviceAgentClient.ts` resolve handler parses
         * `parseDeviceAgentResponseEnvelope` and returns the parsed envelope to the
         * caller, who decides on `ok` themselves. The reject handler builds a
         * `DeviceAgentClientError` from the flat `{code, message}` and discards
         * `status`. Routing operational errors through `reject` would strip the
         * status the browser needs to refresh its UI.
         */
        @JavascriptInterface
        fun deviceAgentRequest(requestId: String, method: String, payloadJson: String) {
            activity.lifecycleScope.launch {
                AgentMwaLog.info(
                    "MainActivity",
                    "deviceAgentRequest",
                    "START",
                    "android device agent bridge request received",
                    deviceAgentPayloadMetadata(requestId, method, payloadJson),
                )
                val envelope: JSONObject = try {
                    buildDeviceAgentEnvelope(requestId, method, payloadJson)
                } catch (cancel: CancellationException) {
                    throw cancel
                } catch (err: Throwable) {
                    AgentMwaLog.failure(
                        "MainActivity",
                        "deviceAgentRequest",
                        "FAIL_ENVELOPE",
                        "failed to build Device Agent envelope; falling back to reject",
                        err,
                        mapOf("requestId" to requestId, "method" to method),
                    )
                    activity.dispatchDeviceAgentReject(
                        requestId,
                        code = errorCodeFor(err),
                        message = err.message ?: err.javaClass.simpleName,
                    )
                    return@launch
                }
                activity.dispatchDeviceAgentResolve(requestId, envelope)
            }
        }

        private suspend fun buildDeviceAgentEnvelope(
            requestId: String,
            method: String,
            payloadJson: String,
        ): JSONObject = try {
            validateDeviceAgentRequest(requestId, method, payloadJson)
            val payload = parseDeviceAgentPayload(payloadJson)
            AgentMwaLog.info(
                "MainActivity",
                "deviceAgentRequest",
                "STEP_PARSED_PAYLOAD",
                "android device agent bridge payload parsed",
                mapOf(
                    "method" to method,
                    "requestId" to requestId,
                    "summary" to deviceAgentPayloadSummary(method, payload),
                ),
            )
            val outcome = handleDeviceAgentRequest(method, payload, requestId)
            AgentMwaLog.info(
                "MainActivity",
                "deviceAgentRequest",
                "SUCCESS",
                "android device agent bridge request resolved",
                mapOf(
                    "method" to method,
                    "requestId" to requestId,
                    "hasResult" to (outcome.result != null),
                ),
            )
            JSONObject()
                .put("ok", true)
                .put("status", outcome.status)
                .apply { if (outcome.result != null) put("result", outcome.result) }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (err: Throwable) {
            val code = errorCodeFor(err)
            val message = err.message ?: err.javaClass.simpleName
            val subcode = (err as? DeviceAgentException)?.subcode
            AgentMwaLog.warn(
                "MainActivity",
                "deviceAgentRequest",
                "OPERATIONAL_ERROR",
                "Device Agent operation produced an error envelope",
                mapOf(
                    "requestId" to requestId,
                    "method" to method,
                    "code" to code,
                    "subcode" to (subcode ?: ""),
                    "class" to err.javaClass.simpleName,
                    "message" to message,
                ),
            )
            val errorObj = JSONObject().put("code", code).put("message", message)
            if (!subcode.isNullOrBlank()) errorObj.put("subcode", subcode)
            JSONObject()
                .put("ok", false)
                .put("status", safeStatusJson())
                .put("error", errorObj)
        }

        private fun parseDeviceAgentPayload(payloadJson: String): JSONObject =
            try {
                if (payloadJson.isBlank()) JSONObject() else JSONObject(payloadJson)
            } catch (err: JSONException) {
                throw DeviceAgentException(
                    code = "invalid_payload",
                    message = err.message ?: "Device Agent payload is not valid JSON.",
                )
            }

        private fun safeStatusJson(): JSONObject =
            try {
                activity.agentRuntimeController.statusJson()
            } catch (err: Throwable) {
                AgentMwaLog.warn(
                    "MainActivity",
                    "safeStatusJson",
                    "FALLBACK",
                    "failed to read Device Agent status; using unavailable fallback",
                    mapOf("class" to err.javaClass.simpleName, "message" to err.message),
                )
                JSONObject()
                    .put("available", false)
                    .put("enabled", false)
                    .put("configured", false)
                    .put("state", "unavailable")
                    .put("runtime", "android-native")
                    .put("message", "Device Agent status unavailable.")
            }

        private fun errorCodeFor(err: Throwable): String = when (err) {
            is DeviceAgentException -> err.code
            is MwaOperationException -> err.code.lowercase()
            is JSONException -> "invalid_payload"
            else -> "device_agent_error"
        }

        @JavascriptInterface
        fun mwaRequest(requestId: String, method: String, payloadJson: String) {
            activity.lifecycleScope.launch {
                try {
                    validateNativeRequest(requestId, method, payloadJson)
                    AgentMwaLog.info(
                        "MainActivity",
                        "mwaRequest",
                        "START",
                        "android js bridge request received",
                        nativePayloadMetadata(requestId, method, payloadJson),
                    )
                    val payload = payloadObject(payloadJson)
                    AgentMwaLog.info(
                        "MainActivity",
                        "mwaRequest",
                        "STEP_PARSED_PAYLOAD",
                        "android js bridge request payload parsed",
                        mapOf("method" to method, "requestId" to requestId, "payload" to if (BuildConfig.DEBUG) payload else "[debug-only]"),
                    )
                    val result = handleMwaRequest(method, payload)
                    AgentMwaLog.info(
                        "MainActivity",
                        "mwaRequest",
                        "SUCCESS",
                        "android js bridge request resolved",
                        mapOf("method" to method, "requestId" to requestId, "result" to if (BuildConfig.DEBUG) result else "[debug-only]"),
                    )
                    activity.resolveMwaRequest(requestId, result)
                } catch (err: Throwable) {
                    AgentMwaLog.failure(
                        "MainActivity",
                        "mwaRequest",
                        "FAIL",
                        "android js bridge request failed",
                        err,
                        nativePayloadMetadata(requestId, method, payloadJson),
                    )
                    activity.rejectMwaRequest(requestId, err)
                }
            }
        }

        private fun validateNativeRequest(requestId: String, method: String, payloadJson: String) {
            if (!REQUEST_ID_PATTERN.matches(requestId)) {
                throw MwaOperationException("INVALID_REQUEST", "Invalid Android MWA bridge request id.")
            }
            if (method !in ALLOWED_METHODS) {
                throw MwaOperationException("UNSUPPORTED_METHOD", "Unsupported Android MWA bridge method: $method")
            }
            if (payloadJson.length > MAX_PAYLOAD_CHARS) {
                throw MwaOperationException("INVALID_REQUEST", "Android MWA bridge payload is too large.")
            }
        }

        private fun validateDeviceAgentRequest(requestId: String, method: String, payloadJson: String) {
            if (!REQUEST_ID_PATTERN.matches(requestId)) {
                throw MwaOperationException("INVALID_REQUEST", "Invalid Android Device Agent bridge request id.")
            }
            if (method !in ALLOWED_DEVICE_AGENT_METHODS) {
                throw MwaOperationException("UNSUPPORTED_METHOD", "Unsupported Android Device Agent bridge method: $method")
            }
            val limit = if (method == "configure" || method == "start") {
                MAX_SECURE_VALUE_CHARS
            } else {
                MAX_PAYLOAD_CHARS
            }
            if (payloadJson.length > limit) {
                throw MwaOperationException(
                    "INVALID_REQUEST",
                    "Android Device Agent bridge payload is too large for $method.",
                )
            }
        }

        private fun validateSecureStoreRequest(key: String, value: String = "") {
            if (key != NativeSecureStore.CLOUD_SESSION_TOKEN_KEY) {
                throw MwaOperationException("INVALID_REQUEST", "Unsupported Android secure storage key.")
            }
            if (value.length > MAX_SECURE_VALUE_CHARS) {
                throw MwaOperationException("INVALID_REQUEST", "Android secure storage value is too large.")
            }
        }

        private fun validateDeviceAgentPayload(value: String) {
            if (value.length > MAX_SECURE_VALUE_CHARS) {
                throw MwaOperationException("INVALID_REQUEST", "Android Device Agent config is too large.")
            }
        }

        private suspend fun handleMwaRequest(method: String, payload: JSONObject): JSONObject {
            AgentMwaLog.info(
                "MainActivity",
                "handleMwaRequest",
                "START",
                "handling Android MWA bridge method",
                mapOf("method" to method, "payload" to if (BuildConfig.DEBUG) payload else "[debug-only]"),
            )
            return when (method) {
                "status" -> statusJson()
                "connect" -> {
                    val record = activity.mwaController.connect(activity, clusterFromPayload(payload))
                    statusJson(record)
                }
                "reconnectLatest" -> {
                    val record = activity.mwaController.reconnectLatest(clusterFromPayload(payload))
                    statusJson(record)
                }
                "capabilities" -> JSONObject()
                    .put("capabilities", activity.mwaController.capabilitiesJson())
                "sign" -> signingResultJson(activity.mwaController.signBridgeRequest(activity, bridgeRequestFromPayload(payload)))
                "disconnect" -> {
                    activity.mwaController.disconnect()
                    statusJson(null)
                }
                "clearTransient" -> {
                    activity.mwaController.clearTransientState("android_js_bridge")
                    statusJson(activity.mwaController.activeAuthorization())
                }
                "fullReset" -> {
                    activity.mwaController.deauthorizeRemote(activity, "android_js_bridge")
                    statusJson(null)
                }
                "clearAllAccounts" -> {
                    activity.mwaController.clearAllCachedAuthorizations()
                    statusJson(null)
                }
                else -> throw MwaOperationException("UNSUPPORTED_METHOD", "Unsupported Android MWA bridge method: $method")
            }
        }

        private suspend fun handleDeviceAgentRequest(
            method: String,
            payload: JSONObject,
            requestId: String,
        ): DeviceAgentOutcome {
            val available = BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT
            if (!available && method != "status") {
                throw DeviceAgentException(
                    "device_agent_unavailable",
                    "Android Device Agent is disabled for this build.",
                )
            }
            return when (method) {
                "status" -> DeviceAgentOutcome(activity.agentRuntimeController.statusJson(), null)
                "configure" -> DeviceAgentOutcome(activity.agentRuntimeController.configure(payload.toString()), null)
                "start" -> DeviceAgentOutcome(activity.agentRuntimeController.start(activity, payload.toString()), null)
                "stop" -> DeviceAgentOutcome(activity.agentRuntimeController.stop(activity), null)
                "generatePlan", "reviewPlan", "ask" -> {
                    val runtimeMethod = RuntimeMethod.fromWire(method)
                        ?: throw DeviceAgentException(
                            code = "unsupported_method",
                            message = "Unsupported Device Agent runtime method: $method",
                        )
                    val request = RuntimeRequest(
                        requestId = requestId,
                        method = runtimeMethod,
                        payload = payload,
                        enqueuedAtMs = System.currentTimeMillis(),
                    )
                    when (val result = activity.agentRuntimeController.submit(request)) {
                        is RuntimeResult.Ok -> DeviceAgentOutcome(
                            activity.agentRuntimeController.statusJson(),
                            result.data,
                        )
                        is RuntimeResult.Failed -> throw DeviceAgentException(
                            code = result.error.code,
                            message = result.error.message,
                            subcode = result.error.subcode,
                        )
                    }
                }
                else -> throw DeviceAgentException(
                    code = "unsupported_method",
                    message = "Unsupported Android Device Agent bridge method: $method",
                )
            }
        }

        private fun deviceAgentPayloadMetadata(requestId: String, method: String, payloadJson: String): Map<String, Any?> =
            mapOf(
                "method" to method,
                "requestId" to requestId,
                "payloadChars" to payloadJson.length,
                "payloadSha256_8" to sha256First8(payloadJson.toByteArray(Charsets.UTF_8)),
            )

        private fun deviceAgentPayloadSummary(method: String, payload: JSONObject): Map<String, Any?> =
            when (method) {
                "configure", "start" -> mapOf(
                    "provider" to payload.optString("provider", ""),
                    "apiFormat" to payload.optString("apiFormat", ""),
                    "model" to payload.optString("model", ""),
                    "hasKey" to payload.optString("apiKey", "").isNotBlank(),
                    "clear" to payload.optBoolean("clear", false),
                )
                else -> mapOf("keys" to payload.keys().asSequence().toList())
            }

        private data class DeviceAgentOutcome(val status: JSONObject, val result: JSONObject?)

        private fun statusJson(record: AgentMwaAuthRecord? = activity.mwaController.activeAuthorization()): JSONObject {
            val json = JSONObject()
                .put("connected", record != null)
                .put("cachedCount", activity.mwaController.cachedAuthorizations().size)
            if (record != null) {
                json
                    .put("address", record.publicKeyBase58)
                    .put("cluster", record.cluster.id)
                    .put("walletPackage", record.walletPackage)
                    .put("accountLabel", record.accountLabel)
                    .put("capabilities", activity.mwaController.capabilitiesJson())
            }
            AgentMwaLog.info(
                "MainActivity",
                "statusJson",
                "DONE",
                "Android MWA status JSON prepared",
                mapOf("connected" to (record != null), "cachedCount" to activity.mwaController.cachedAuthorizations().size, "result" to if (BuildConfig.DEBUG) json else "[debug-only]"),
            )
            return json
        }

        private fun payloadObject(payloadJson: String): JSONObject =
            try {
                if (payloadJson.isBlank()) JSONObject() else JSONObject(payloadJson)
            } catch (err: Exception) {
                AgentMwaLog.failure(
                    "MainActivity",
                    "payloadObject",
                    "FAIL_PARSE",
                    "failed to parse Android MWA bridge payload JSON",
                    err,
                    mapOf("payloadChars" to payloadJson.length, "payloadJson" to if (BuildConfig.DEBUG) payloadJson else "[debug-only]"),
                )
                throw err
            }

        private fun clusterFromPayload(payload: JSONObject): AgentCluster =
            AgentCluster.requireSupported(payload.optString("cluster", "devnet"))

        private fun bridgeRequestFromPayload(payload: JSONObject): AgentMwaBridgeRequest {
            val signingPayload = payload.optJSONObject("payload") ?: JSONObject()
            val display = payload.optJSONObject("display")
            val request = AgentMwaBridgeRequest(
                id = payload.optString("id", ""),
                kind = payload.optString("kind", ""),
                payloadData = signingPayload.optString("data", ""),
                payloadEncoding = signingPayload.optString("encoding", "base64"),
                cluster = AgentCluster.requireSupported(payload.optString("cluster", "devnet")),
                rpcUrl = payload.optString("rpcUrl", "").takeIf { it.isNotBlank() },
                summary = display?.optString("summary")?.takeIf { it.isNotBlank() },
            )
            AgentMwaLog.info(
                "MainActivity",
                "bridgeRequestFromPayload",
                "DONE",
                "Android MWA signing bridge request prepared",
                bridgeRequestLogMetadata(request),
            )
            return request
        }

        private fun signingResultJson(result: AgentMwaSigningResult): JSONObject {
            val json = JSONObject().put("signature", result.signature)
            if (result.txid != null) {
                json.put("txid", result.txid)
            }
            AgentMwaLog.info(
                "MainActivity",
                "signingResultJson",
                "DONE",
                "Android MWA signing result JSON prepared",
                mapOf("signature" to result.signature, "txid" to result.txid.orEmpty(), "result" to if (BuildConfig.DEBUG) json else "[debug-only]"),
            )
            return json
        }

        private fun nativePayloadMetadata(requestId: String, method: String, payloadJson: String): Map<String, Any?> =
            mapOf(
                "method" to method,
                "requestId" to requestId,
                "payloadChars" to payloadJson.length,
                "payloadSha256_8" to sha256First8(payloadJson.toByteArray(Charsets.UTF_8)),
                "payloadJson" to if (BuildConfig.DEBUG) payloadJson else "[debug-only]",
            )

        private fun bridgeRequestLogMetadata(request: AgentMwaBridgeRequest): Map<String, Any?> =
            mapOf(
                "requestId" to request.id,
                "kind" to request.kind,
                "cluster" to request.cluster.id,
                "rpcUrl" to request.rpcUrl.orEmpty(),
                "summary" to request.summary.orEmpty(),
                "payloadEncoding" to request.payloadEncoding,
                "payloadChars" to request.payloadData.length,
                "payloadSha256_8" to sha256First8(request.payloadData.toByteArray(Charsets.UTF_8)),
                "payloadData" to if (BuildConfig.DEBUG) request.payloadData else "[debug-only]",
            )

        private companion object {
            private val REQUEST_ID_PATTERN = Regex("^[A-Za-z0-9_.:-]{1,160}$")
            private val ALLOWED_METHODS = setOf(
                "status",
                "connect",
                "reconnectLatest",
                "capabilities",
                "sign",
                "disconnect",
                "clearTransient",
                "fullReset",
                "clearAllAccounts",
            )
            private val ALLOWED_DEVICE_AGENT_METHODS = setOf(
                "status",
                "configure",
                "start",
                "stop",
                "generatePlan",
                "reviewPlan",
                "ask",
            )
            private const val MAX_PAYLOAD_CHARS = 2_000_000
            private const val MAX_SECURE_VALUE_CHARS = 8192
        }
    }

    private class DeviceAgentException(
        val code: String,
        message: String,
        val subcode: String? = null,
    ) : RuntimeException(message)

    private class BundledAppPathHandler(private val context: Context) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val normalized = path.trimStart('/').ifBlank { "index.html" }
            val assetPath = if (normalized.contains("..")) "index.html" else normalized
            val stream = try {
                context.assets.open(assetPath)
            } catch (_: FileNotFoundException) {
                context.assets.open("index.html")
            }
            return WebResourceResponse(mimeType(assetPath), "UTF-8", stream)
        }

        private fun mimeType(path: String): String =
            when (path.substringAfterLast('.', "").lowercase()) {
                "css" -> "text/css"
                "js", "mjs" -> "application/javascript"
                "json", "webmanifest" -> "application/json"
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "svg" -> "image/svg+xml"
                "ico" -> "image/x-icon"
                "wasm" -> "application/wasm"
                else -> "text/html"
            }
    }

    private companion object {
        private const val LOCAL_APP_HOST = "agentic.local"
        private const val LOCAL_APP_START_URL = "https://agentic.local/"

        private fun sha256First8(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256")
                .digest(bytes)
                .take(8)
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}
