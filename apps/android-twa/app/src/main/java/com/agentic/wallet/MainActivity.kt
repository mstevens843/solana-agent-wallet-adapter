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
import com.agentic.wallet.agent.StreamingVoucherWorker
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
import com.agentic.wallet.mwa.WalletRegistry
import com.agentic.wallet.streaming.StreamingSessionException
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.FileNotFoundException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var mwaController: MwaController
    private lateinit var secureStore: NativeSecureStore
    private lateinit var agentRuntimeController: AgentRuntimeController
    private lateinit var activityResultSender: ActivityResultSender

    private val remoteWebUrl: String = BuildConfig.AGENTIC_ANDROID_REMOTE_WEB_URL
    private val remoteWebHost: String? = remoteWebUrl
        .takeIf { it.isNotBlank() }
        ?.let { runCatching { Uri.parse(it).host?.lowercase() }.getOrNull() }
    private var didFallback = false

    // Top-frame URL cache for the origin guard. WebView.getUrl() is UI-thread only and
    // throws RuntimeException when called from the WebView's @JavascriptInterface JS
    // thread; that throw used to surface as "Java exception was raised during method
    // invocation" on every bridge call. We snapshot the URL from the UI thread inside
    // WebViewClient callbacks and have isCurrentOriginAllowed() read this reference.
    private val currentWebViewOrigin = AtomicReference<String?>(null)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // CRITICAL: ActivityResultSender must be constructed BEFORE the activity reaches STARTED.
        // Its constructor calls registerForActivityResult(), which Android refuses past STARTED.
        // See KNOWN_ISSUES.md "ActivityResultSender lifecycle violation" in grant-godot.
        activityResultSender = ActivityResultSender(this)
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
                "remoteWebUrl" to remoteWebUrl,
                "remoteWebHost" to (remoteWebHost ?: ""),
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

                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    currentWebViewOrigin.set(url)
                }

                override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                    currentWebViewOrigin.set(url)
                }

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
                    maybeFallbackToBundled(view, request, "error_${error.errorCode}")
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
                    if (errorResponse.statusCode in 500..599) {
                        maybeFallbackToBundled(view, request, "http_${errorResponse.statusCode}")
                    }
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val uri = request.url ?: return false
                    if (isAllowedInWebView(uri)) return false
                    openExternal(uri)
                    return true
                }
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        setContentView(webView)
        applySystemBarInsets(webView)

        if (savedInstanceState == null) {
            val startUrl = if (remoteWebUrl.isNotBlank()) remoteWebUrl else LOCAL_APP_START_URL
            // Seed the origin cache before loadUrl returns. onPageStarted will overwrite this
            // once the page actually loads, but bridge calls during early page bootstrap need
            // a non-null value to satisfy the origin guard.
            currentWebViewOrigin.set(startUrl)
            webView.loadUrl(startUrl)
        }
    }

    private fun isAllowedInWebView(uri: Uri): Boolean {
        if (uri.scheme != "https") return false
        val host = uri.host?.lowercase() ?: return false
        if (host == LOCAL_APP_HOST) return true
        return remoteWebHost != null && host == remoteWebHost
    }

    internal fun isCurrentOriginAllowed(): Boolean {
        val current = currentWebViewOrigin.get() ?: return false
        val uri = runCatching { Uri.parse(current) }.getOrNull() ?: return false
        return isAllowedInWebView(uri)
    }

    private fun maybeFallbackToBundled(view: WebView, request: WebResourceRequest, reason: String) {
        if (didFallback) return
        if (!request.isForMainFrame) return
        if (remoteWebHost == null) return
        val host = request.url?.host?.lowercase() ?: return
        if (host != remoteWebHost) return
        didFallback = true
        AgentMwaLog.warn(
            "MainActivity",
            "maybeFallbackToBundled",
            "REMOTE_LOAD_FAILED",
            "remote web shell failed; falling back to bundled assets",
            mapOf(
                "reason" to reason,
                "url" to request.url,
            ),
        )
        view.loadUrl(LOCAL_APP_START_URL)
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
            return
        }
        super.onBackPressed()
    }

    private fun defaultMwaIdentity(): AgentMwaIdentity {
        // When the WebView loads from a remote origin, the MWA identity URI must match that
        // origin — otherwise wallets show users the wrong domain in connect/sign dialogs.
        val source = remoteWebUrl.ifBlank { BuildConfig.AGENTIC_LAUNCH_URL }
        val launch = Uri.parse(source)
        val scheme = launch.scheme ?: "https"
        val host = launch.host ?: "agenticwalletadapter.com"
        val origin = "$scheme://$host${if (launch.port > 0) ":${launch.port}" else ""}"
        return AgentMwaIdentity(
            name = "Agentic",
            uri = origin,
            // MWA spec: iconRelativeUri is RELATIVE to identityUri. Passing an absolute URI
            // makes ConnectionIdentity throw "iconRelativeUri must be a relative uri" before
            // the wallet ever responds — that's the bug Mathew hit on Seed Vault + Backpack.
            iconUri = "favicon.ico",
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

    private fun dispatchStreamingResolve(requestId: String, envelope: JSONObject) {
        if (isDestroyed) {
            AgentMwaLog.warn(
                "MainActivity",
                "dispatchStreamingResolve",
                "ACTIVITY_DESTROYED",
                "skipped Streaming resolve on destroyed activity",
                mapOf("requestId" to requestId),
            )
            return
        }
        val js =
            "(function(){var b=window.__agenticAndroidStreamingBridge;if(b&&b.resolve){b.resolve(${JSONObject.quote(requestId)},$envelope);}})();"
        AgentMwaLog.info(
            "MainActivity",
            "dispatchStreamingResolve",
            "START",
            "evaluating Streaming resolve callback",
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
                "dispatchStreamingResolve",
                "DONE",
                "Streaming resolve callback evaluated",
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
            mapOf(
                "requestId" to requestId,
                "payload" to if (BuildConfig.DEBUG) mwaJsonLogSummary(payload) else "[debug-only]",
                "payloadBytes" to payload.toString().toByteArray(Charsets.UTF_8).size,
            ),
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
            mapOf("requestId" to requestId, "code" to code, "payload" to if (BuildConfig.DEBUG) mwaJsonLogSummary(payload) else "[debug-only]"),
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
            mapOf(
                "callback" to callback,
                "requestId" to requestId,
                "payload" to if (BuildConfig.DEBUG) mwaJsonLogSummary(payload) else "[debug-only]",
                "payloadBytes" to payload.toString().toByteArray(Charsets.UTF_8).size,
                "jsChars" to js.length,
                "jsSha256_8" to sha256First8(js.toByteArray(Charsets.UTF_8)),
            ),
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

    private fun mwaJsonLogSummary(value: JSONObject): JSONObject =
        redactMwaLogValue(JSONObject(value.toString())) as JSONObject

    private fun redactMwaLogValue(value: Any?): Any? =
        when (value) {
            is JSONObject -> {
                val keys = value.keys().asSequence().toList()
                for (key in keys) {
                    if (key == "walletIcon") {
                        value.put(key, walletIconLogJson(value.optString(key, "")))
                    } else {
                        value.put(key, redactMwaLogValue(value.opt(key)))
                    }
                }
                value
            }
            is JSONArray -> {
                for (index in 0 until value.length()) {
                    value.put(index, redactMwaLogValue(value.opt(index)))
                }
                value
            }
            else -> value
        }

    private fun walletIconLogJson(walletIcon: String): JSONObject {
        val json = JSONObject().put("redacted", true)
        for ((key, metadataValue) in WalletRegistry.walletIconLogMetadata(walletIcon)) {
            json.put(key, metadataValue)
        }
        return json
    }

    private fun payloadJsonLogSummary(payloadJson: String): Any =
        runCatching { mwaJsonLogSummary(JSONObject(payloadJson)) }
            .getOrElse { "[unparseable-json]" }

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
        // Top-frame origin guard. addJavascriptInterface exposes this bridge to whatever URL
        // the WebView is showing; we gate every callable here so a navigation hijack to a
        // foreign host (or future build that loads an extra URL) can't reach native APIs.
        // Returns true if the call should proceed. Logs and denies otherwise.
        // Does NOT defend against in-page cross-origin iframes — addJavascriptInterface has
        // no per-frame visibility; that requires migrating to addWebMessageListener.
        private fun checkTrustedOrigin(method: String): Boolean {
            if (activity.isCurrentOriginAllowed()) return true
            AgentMwaLog.warn(
                "AndroidBridge",
                method,
                "BRIDGE_ORIGIN_DENIED",
                "rejecting bridge call from unallowed top-frame origin",
                mapOf("method" to method),
            )
            return false
        }

        // Defense-in-depth for async bridge methods (mwaRequest, deviceAgentRequest,
        // streamingRequest): if the synchronous origin-check throws, surface it through the
        // JS callback bridge instead of letting it escape as a V8 "Java exception" — JS
        // gets a proper ProtocolError it can render and recover from.
        private fun safeCheckTrustedOrigin(method: String, requestId: String): Boolean = try {
            checkTrustedOrigin(method)
        } catch (err: Throwable) {
            AgentMwaLog.failure(
                "AndroidBridge",
                method,
                "SYNC_THROW",
                "origin check threw; routing as rejected request",
                err,
                mapOf("method" to method, "requestId" to requestId),
            )
            runCatching { activity.rejectMwaRequest(requestId, err) }
            false
        }

        // Defense-in-depth for sync return-valued bridge methods. Wraps the body so a sync
        // throw (lateinit-not-initialized, NPE, etc.) is logged and the JS side gets the
        // same shape as the origin-denied path instead of an opaque V8 exception.
        private inline fun <T> safeBridge(method: String, default: T, block: () -> T): T = try {
            block()
        } catch (err: Throwable) {
            AgentMwaLog.failure(
                "AndroidBridge",
                method,
                "SYNC_THROW",
                "bridge method sync body threw; returning default",
                err,
                mapOf("method" to method),
            )
            default
        }

        @JavascriptInterface
        fun openMwaExample() = safeBridge("openMwaExample", Unit) {
            if (!checkTrustedOrigin("openMwaExample")) return@safeBridge
            val intent = Intent(activity, MwaExampleActivity::class.java)
            activity.startActivity(intent)
        }

        @JavascriptInterface
        fun isExampleTabEnabled(): Boolean = safeBridge("isExampleTabEnabled", false) {
            if (!checkTrustedOrigin("isExampleTabEnabled")) return@safeBridge false
            BuildConfig.AGENTIC_ANDROID_SHOW_EXAMPLE_TAB
        }

        @JavascriptInterface
        fun isDebugBuild(): Boolean = safeBridge("isDebugBuild", false) {
            if (!checkTrustedOrigin("isDebugBuild")) return@safeBridge false
            BuildConfig.DEBUG
        }

        @JavascriptInterface
        fun secureGet(key: String): String = safeBridge("secureGet", "") {
            if (!checkTrustedOrigin("secureGet")) return@safeBridge ""
            validateSecureStoreRequest(key)
            activity.secureStore.get(key).orEmpty()
        }

        @JavascriptInterface
        fun secureSet(key: String, value: String): Boolean = safeBridge("secureSet", false) {
            if (!checkTrustedOrigin("secureSet")) return@safeBridge false
            validateSecureStoreRequest(key, value)
            activity.secureStore.set(key, value)
            true
        }

        @JavascriptInterface
        fun secureDelete(key: String): Boolean = safeBridge("secureDelete", false) {
            if (!checkTrustedOrigin("secureDelete")) return@safeBridge false
            validateSecureStoreRequest(key)
            activity.secureStore.remove(key)
            true
        }

        @JavascriptInterface
        fun deviceAgentStatus(): String = safeBridge("deviceAgentStatus", "{}") {
            if (!checkTrustedOrigin("deviceAgentStatus")) return@safeBridge "{}"
            activity.agentRuntimeController.statusJson().toString()
        }

        @JavascriptInterface
        fun deviceAgentConfigure(configJson: String): String = safeBridge("deviceAgentConfigure", "{}") {
            if (!checkTrustedOrigin("deviceAgentConfigure")) return@safeBridge "{}"
            validateDeviceAgentPayload(configJson)
            activity.agentRuntimeController.configure(configJson).toString()
        }

        @JavascriptInterface
        fun deviceAgentStart(configJson: String): String = safeBridge("deviceAgentStart", "{}") {
            if (!checkTrustedOrigin("deviceAgentStart")) return@safeBridge "{}"
            validateDeviceAgentPayload(configJson)
            activity.agentRuntimeController.start(activity, configJson).toString()
        }

        @JavascriptInterface
        fun deviceAgentStop(): String = safeBridge("deviceAgentStop", "{}") {
            if (!checkTrustedOrigin("deviceAgentStop")) return@safeBridge "{}"
            activity.agentRuntimeController.stop(activity).toString()
        }

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
            val originOk = try {
                checkTrustedOrigin("deviceAgentRequest")
            } catch (err: Throwable) {
                AgentMwaLog.failure(
                    "AndroidBridge",
                    "deviceAgentRequest",
                    "SYNC_THROW",
                    "origin check threw; routing as rejected request",
                    err,
                    mapOf("requestId" to requestId, "method" to method),
                )
                runCatching {
                    activity.dispatchDeviceAgentReject(
                        requestId,
                        code = errorCodeFor(err),
                        message = err.message ?: err.javaClass.simpleName,
                    )
                }
                return
            }
            if (!originOk) return
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

        /**
         * Phase 0 scaffolding bridge for the Machine Payments Protocol (MPP).
         * Phase 1 will route this to a Kotlin-side MPP HTTP-402 interceptor.
         * Returns a JSON envelope synchronously; the browser-side
         * `androidBridgeShim.ts` wrapper parses it and falls back to cloud HTTP
         * when this method is absent.
         */
        @JavascriptInterface
        fun mppRequest(requestId: String, method: String, payloadJson: String): String =
            safeBridge("mppRequest", errorEnvelope("mpp", requestId, method, RuntimeException("bridge sync prelude failed"))) {
                if (!checkTrustedOrigin("mppRequest")) {
                    return@safeBridge errorEnvelope("mpp", requestId, method, SecurityException("origin denied"))
                }
                runCatching {
                    validateScaffoldedBridgeRequest(requestId, method, payloadJson)
                    notImplementedEnvelope("mpp", requestId, method)
                }.getOrElse { err ->
                    errorEnvelope("mpp", requestId, method, err)
                }
            }

        /**
         * Async bridge for streaming-payment sessions. The browser installs
         * `window.__agenticAndroidStreamingBridge`; this method queues native
         * work and resolves operational success/failure through that callback
         * contract so signing never blocks the WebView thread.
         */
        @JavascriptInterface
        fun streamingRequest(requestId: String, method: String, payloadJson: String) {
            val originOk = try {
                checkTrustedOrigin("streamingRequest")
            } catch (err: Throwable) {
                AgentMwaLog.failure(
                    "AndroidBridge",
                    "streamingRequest",
                    "SYNC_THROW",
                    "origin check threw; routing as rejected request",
                    err,
                    mapOf("requestId" to requestId, "method" to method),
                )
                runCatching {
                    val code = streamingErrorCodeFor(err)
                    val message = err.message ?: err.javaClass.simpleName
                    activity.dispatchStreamingResolve(
                        requestId,
                        JSONObject()
                            .put("ok", false)
                            .put("bridge", "streaming")
                            .put("requestId", requestId)
                            .put("method", method)
                            .put("status", safeStreamingStatusJson())
                            .put("error", JSONObject().put("code", code).put("message", message)),
                    )
                }
                return
            }
            if (!originOk) return
            activity.lifecycleScope.launch {
                val envelope = try {
                    validateStreamingBridgeRequest(requestId, method, payloadJson)
                    AgentMwaLog.info(
                        "MainActivity",
                        "streamingRequest",
                        "START",
                        "android streaming bridge request received",
                        mapOf(
                            "method" to method,
                            "requestId" to requestId,
                            "payloadChars" to payloadJson.length,
                            "payloadSha256_8" to sha256First8(payloadJson.toByteArray(Charsets.UTF_8)),
                        ),
                    )
                    val payload = parseStreamingPayload(payloadJson)
                    val result = StreamingVoucherWorker.submit(activity.applicationContext, method, payload)
                    JSONObject()
                        .put("ok", true)
                        .put("bridge", "streaming")
                        .put("requestId", requestId)
                        .put("method", method)
                        .put("status", StreamingVoucherWorker.statusJson(activity.applicationContext))
                        .put("result", result)
                } catch (cancel: CancellationException) {
                    throw cancel
                } catch (err: Throwable) {
                    val code = streamingErrorCodeFor(err)
                    val message = err.message ?: err.javaClass.simpleName
                    AgentMwaLog.warn(
                        "MainActivity",
                        "streamingRequest",
                        "OPERATIONAL_ERROR",
                        "Streaming bridge operation produced an error envelope",
                        mapOf(
                            "requestId" to requestId,
                            "method" to method,
                            "code" to code,
                            "class" to err.javaClass.simpleName,
                            "message" to message,
                        ),
                    )
                    JSONObject()
                        .put("ok", false)
                        .put("bridge", "streaming")
                        .put("requestId", requestId)
                        .put("method", method)
                        .put("status", safeStreamingStatusJson())
                        .put("error", JSONObject().put("code", code).put("message", message))
                }
                activity.dispatchStreamingResolve(requestId, envelope)
            }
        }

        private fun parseStreamingPayload(payloadJson: String): JSONObject =
            try {
                if (payloadJson.isBlank()) JSONObject() else JSONObject(payloadJson)
            } catch (err: JSONException) {
                throw StreamingSessionException(
                    code = "invalid_payload",
                    message = err.message ?: "Streaming bridge payload is not valid JSON.",
                    cause = err,
                )
            }

        private fun safeStreamingStatusJson(): JSONObject =
            try {
                StreamingVoucherWorker.statusJson(activity.applicationContext)
            } catch (err: Throwable) {
                AgentMwaLog.warn(
                    "MainActivity",
                    "safeStreamingStatusJson",
                    "FALLBACK",
                    "failed to read Streaming status; using unavailable fallback",
                    mapOf("class" to err.javaClass.simpleName, "message" to err.message),
                )
                JSONObject()
                    .put("available", false)
                    .put("runtime", "android-native")
                    .put("activeSessions", 0)
                    .put("remainingDisplay", "\$0.00")
                    .put("message", "Streaming session status unavailable.")
            }

        private fun streamingErrorCodeFor(err: Throwable): String = when (err) {
            is StreamingSessionException -> err.code
            is MwaOperationException -> err.code.lowercase()
            is JSONException -> "invalid_payload"
            else -> "streaming_error"
        }

        private fun validateScaffoldedBridgeRequest(requestId: String, method: String, payloadJson: String) {
            if (!REQUEST_ID_PATTERN.matches(requestId)) {
                throw MwaOperationException("INVALID_REQUEST", "Invalid scaffolded bridge request id.")
            }
            if (method.isBlank() || method.length > 64) {
                throw MwaOperationException("UNSUPPORTED_METHOD", "Invalid scaffolded bridge method.")
            }
            if (payloadJson.length > MAX_PAYLOAD_CHARS) {
                throw MwaOperationException("INVALID_REQUEST", "Scaffolded bridge payload is too large.")
            }
        }

        private fun validateStreamingBridgeRequest(requestId: String, method: String, payloadJson: String) {
            if (!REQUEST_ID_PATTERN.matches(requestId)) {
                throw MwaOperationException("INVALID_REQUEST", "Invalid Android Streaming bridge request id.")
            }
            if (method !in ALLOWED_STREAMING_METHODS) {
                throw MwaOperationException("UNSUPPORTED_METHOD", "Unsupported Android Streaming bridge method: $method")
            }
            if (payloadJson.length > MAX_PAYLOAD_CHARS) {
                throw MwaOperationException("INVALID_REQUEST", "Android Streaming bridge payload is too large.")
            }
        }

        private fun notImplementedEnvelope(bridge: String, requestId: String, method: String): String =
            JSONObject()
                .put("ok", false)
                .put("status", "not_implemented")
                .put("phase", "phase_0_scaffolding")
                .put("bridge", bridge)
                .put("requestId", requestId)
                .put("method", method)
                .toString()

        private fun errorEnvelope(bridge: String, requestId: String, method: String, err: Throwable): String =
            JSONObject()
                .put("ok", false)
                .put("status", "error")
                .put("bridge", bridge)
                .put("requestId", requestId)
                .put("method", method)
                .put("code", if (err is MwaOperationException) err.code else "INTERNAL_ERROR")
                .put("message", err.message ?: "Unknown error.")
                .toString()

        @JavascriptInterface
        fun mwaRequest(requestId: String, method: String, payloadJson: String) {
            if (!safeCheckTrustedOrigin("mwaRequest", requestId)) return
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
                        mapOf("method" to method, "requestId" to requestId, "payload" to if (BuildConfig.DEBUG) activity.mwaJsonLogSummary(payload) else "[debug-only]"),
                    )
                    val result = handleMwaRequest(method, payload)
                    AgentMwaLog.info(
                        "MainActivity",
                        "mwaRequest",
                        "SUCCESS",
                        "android js bridge request resolved",
                        mapOf("method" to method, "requestId" to requestId, "result" to if (BuildConfig.DEBUG) activity.mwaJsonLogSummary(result) else "[debug-only]"),
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
                mapOf("method" to method, "payload" to if (BuildConfig.DEBUG) activity.mwaJsonLogSummary(payload) else "[debug-only]"),
            )
            return when (method) {
                "status" -> statusJson()
                "connect" -> {
                    val record = activity.mwaController.connect(activity.activityResultSender, clusterFromPayload(payload))
                    statusJson(record)
                }
                "reconnectLatest" -> {
                    val record = activity.mwaController.reconnectLatest(clusterFromPayload(payload))
                    statusJson(record)
                }
                "capabilities" -> JSONObject()
                    .put("capabilities", activity.mwaController.capabilitiesJson())
                "sign" -> signingResultJson(activity.mwaController.signBridgeRequest(activity.activityResultSender, bridgeRequestFromPayload(payload)))
                "signIn" -> {
                    // MWA 2.0 Auth 2.0 / Sign In With Solana (SIWS). Parity with grant-godot PR #453
                    // and Unity SIWS PR. One-shot authorize + ownership proof. Domain + statement
                    // are the only required fields; everything else flows from MWA clientlib defaults.
                    val domain = payload.optString("domain", "").trim()
                    val statement = payload.optString("statement", "").trim()
                    val signInResult = activity.mwaController.connectWithSignIn(
                        activity.activityResultSender,
                        clusterFromPayload(payload),
                        domain,
                        statement,
                    )
                    signInResultJson(signInResult)
                }
                "getAuthToken" -> {
                    // Parity with grant-godot PR #449 and Unity AuthToken getter.
                    val token = activity.mwaController.getAuthToken()
                    val record = activity.mwaController.activeAuthorization()
                        ?: activity.mwaController.cachedAuthorizations().maxByOrNull { it.timestampUnixSeconds }
                    JSONObject()
                        .put("authToken", token)
                        .put("authTokenLen", token.length)
                        .put("publicKey", record?.publicKeyBase58.orEmpty())
                        .put("walletPackage", record?.walletPackage.orEmpty())
                        .put("cluster", record?.cluster?.id.orEmpty())
                }
                "setAuthToken" -> {
                    // Parity with grant-godot PR #449 setAuthToken. Hydrate cache from JS-supplied
                    // token (e.g. restored from cloud workspace backup).
                    val token = payload.optString("authToken", "").ifBlank { payload.optString("token", "") }
                    val publicKey = payload.optString("publicKey", "")
                        .ifBlank { payload.optString("publicKeyBase58", "") }
                        .ifBlank { payload.optString("address", "") }
                    val walletPackage = payload.optString("walletPackage", "")
                    val clusterId = payload.optString("cluster", "")
                    val cluster = if (clusterId.isBlank()) AgentCluster.MainnetBeta else AgentCluster.requireSupported(clusterId)
                    val record = activity.mwaController.setAuthToken(token, publicKey, walletPackage, cluster)
                    statusJson(record)
                }
                "disconnect" -> {
                    activity.mwaController.disconnect()
                    statusJson(null)
                }
                "clearTransient" -> {
                    activity.mwaController.clearTransientState("android_js_bridge")
                    statusJson(activity.mwaController.activeAuthorization())
                }
                "fullReset" -> {
                    activity.mwaController.deauthorizeRemote(activity.activityResultSender, "android_js_bridge")
                    statusJson(null)
                }
                "clearAllAccounts" -> {
                    activity.mwaController.clearAllCachedAuthorizations()
                    statusJson(null)
                }
                "detectWallets" -> {
                    // Cocos parity: enumerate installed MWA-compatible wallets.
                    JSONObject().put("wallets", com.agentic.wallet.mwa.WalletDetector.detectInstalledWallets(activity))
                }
                "detectDevice" -> {
                    // Cocos parity: surface Seeker/Saga detection so the web app can adjust UX.
                    com.agentic.wallet.mwa.WalletDetector.detectDevice()
                }
                "signatureStatus" -> {
                    // JS-bridge RPC read: api.mainnet-beta.solana.com returns 403 to the
                    // WebView origin, so the JS confirmation poller routes through here.
                    val txid = payload.optString("txid", "")
                        .ifBlank { throw MwaOperationException("INVALID_REQUEST", "signatureStatus requires txid") }
                    val cluster = clusterFromPayload(payload)
                    val rpcUrl = payload.optString("rpcUrl", "").ifBlank { null }
                    activity.mwaController.signatureStatusViaRpc(cluster, txid, rpcUrl)
                }
                "latestBlockhash" -> {
                    val cluster = clusterFromPayload(payload)
                    val rpcUrl = payload.optString("rpcUrl", "").ifBlank { null }
                    activity.mwaController.latestBlockhashViaRpc(cluster, rpcUrl)
                }
                "sendRawTransaction" -> {
                    val base64 = payload.optString("signedTransactionBase64", "")
                        .ifBlank { throw MwaOperationException("INVALID_REQUEST", "sendRawTransaction requires signedTransactionBase64") }
                    val cluster = clusterFromPayload(payload)
                    val rpcUrl = payload.optString("rpcUrl", "").ifBlank { null }
                    activity.mwaController.sendRawTransactionViaRpc(cluster, base64, rpcUrl)
                }
                else -> throw MwaOperationException("UNSUPPORTED_METHOD", "Unsupported Android MWA bridge method: $method")
            }
        }

        private fun signInResultJson(result: com.agentic.wallet.mwa.AgentMwaSignInResult): JSONObject {
            val json = JSONObject()
                .put("signature", result.signature)
                .put("signedMessage", result.signedMessage)
                .put("publicKey", result.publicKeyBase58)
                .put("address", result.publicKeyBase58)
                .put("accountLabel", result.accountLabel)
                .put("chains", org.json.JSONArray(result.chains))
                .put("features", org.json.JSONArray(result.features))
                .put("authToken", result.authToken)
                .put("authTokenLen", result.authToken.length)
                .put("walletPackage", result.walletPackage)
                .put("cluster", result.cluster)
                .put("path", result.path)
            AgentMwaLog.info(
                "MainActivity",
                "signInResultJson",
                "DONE",
                "Android MWA SIWS result JSON prepared",
                mapOf(
                    "signature" to result.signature,
                    "publicKey" to result.publicKeyBase58,
                    "accountLabel" to result.accountLabel,
                    "path" to result.path,
                    "chainsCount" to result.chains.size,
                    "featuresCount" to result.features.size,
                    "authTokenLen" to result.authToken.length,
                ),
            )
            return json
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
                    .put("walletType", record.walletType)
                    .put("walletUriBase", record.walletUriBase)
                    .put("walletIcon", record.walletIcon)
                    .put("walletPackage", record.walletPackage)
                    .put("accountLabel", record.accountLabel)
                    .put("capabilities", activity.mwaController.capabilitiesJson())
            }
            AgentMwaLog.info(
                "MainActivity",
                "statusJson",
                "DONE",
                "Android MWA status JSON prepared",
                mapOf(
                    "connected" to (record != null),
                    "cachedCount" to activity.mwaController.cachedAuthorizations().size,
                    "result" to if (BuildConfig.DEBUG) activity.mwaJsonLogSummary(json) else "[debug-only]",
                ),
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
                    mapOf(
                        "payloadChars" to payloadJson.length,
                        "payloadSha256_8" to sha256First8(payloadJson.toByteArray(Charsets.UTF_8)),
                    ),
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
            // Surface the ownership-proof memo-tx fallback shape to the JS layer so the
            // cloud auth verify endpoint can pick the right verification path. Existing
            // sign-message / sign-transaction / sign-and-send results emit "utf8" (or
            // omit the field entirely after the default-stripping below) and stay backwards
            // compatible.
            if (result.encoding != "utf8") {
                json.put("encoding", result.encoding)
            }
            if (!result.transactionBase64.isNullOrBlank()) {
                json.put("transactionBase64", result.transactionBase64)
            }
            AgentMwaLog.info(
                "MainActivity",
                "signingResultJson",
                "DONE",
                "Android MWA signing result JSON prepared",
                mapOf(
                    "signature" to result.signature,
                    "txid" to result.txid.orEmpty(),
                    "encoding" to result.encoding,
                    "hasTransactionBase64" to !result.transactionBase64.isNullOrBlank(),
                    "result" to if (BuildConfig.DEBUG) json else "[debug-only]",
                ),
            )
            return json
        }

        private fun nativePayloadMetadata(requestId: String, method: String, payloadJson: String): Map<String, Any?> =
            mapOf(
                "method" to method,
                "requestId" to requestId,
                "payloadChars" to payloadJson.length,
                "payloadSha256_8" to sha256First8(payloadJson.toByteArray(Charsets.UTF_8)),
                "payload" to if (BuildConfig.DEBUG) activity.payloadJsonLogSummary(payloadJson) else "[debug-only]",
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
                "signIn",
                "getAuthToken",
                "setAuthToken",
                "disconnect",
                "clearTransient",
                "fullReset",
                "clearAllAccounts",
                "detectWallets",
                "detectDevice",
                "signatureStatus",
                "latestBlockhash",
                "sendRawTransaction",
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
            private val ALLOWED_STREAMING_METHODS = setOf(
                "status",
                "capabilities",
                "prepareSessionSigner",
                "createSession",
                "activateSession",
                "signVoucher",
                "signSettlementTx",
                "revokeLocalSession",
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
            val safePath = if (normalized.contains("..")) "index.html" else normalized

            // 1. Real asset — serve as-is.
            runCatching { context.assets.open(safePath) }
                .getOrNull()
                ?.let { stream -> return WebResourceResponse(mimeType(safePath), "UTF-8", stream) }

            // 2. SPA route (no extension, not under /api, /assets, /bridge) — serve index.html
            //    so client-side routing for paths like /app, /inbox keeps working.
            val looksLikeSpaRoute = !safePath.contains('.') &&
                !safePath.startsWith("api/") &&
                !safePath.startsWith("assets/") &&
                !safePath.startsWith("bridge/")
            if (looksLikeSpaRoute) {
                val stream = context.assets.open("index.html")
                return WebResourceResponse("text/html", "UTF-8", stream)
            }

            // 3. Genuinely missing — return a real 404. Masquerading /api/* as index.html
            //    breaks JS callers (signature-status polling, latest-blockhash, etc.) by
            //    delivering HTML where they expect JSON; the content-type check throws but
            //    only after wasting a full WebView roundtrip per poll iteration.
            return WebResourceResponse(
                "application/json",
                "UTF-8",
                404,
                "Not Found",
                emptyMap(),
                java.io.ByteArrayInputStream("{\"error\":\"not_found\"}".toByteArray(Charsets.UTF_8)),
            )
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
