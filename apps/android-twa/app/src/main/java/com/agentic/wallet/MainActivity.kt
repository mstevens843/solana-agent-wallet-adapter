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
import com.agentic.wallet.mwa.AgentCluster
import com.agentic.wallet.mwa.AgentMwaAuthRecord
import com.agentic.wallet.mwa.AgentMwaBridgeRequest
import com.agentic.wallet.mwa.AgentMwaIdentity
import com.agentic.wallet.mwa.AgentMwaLog
import com.agentic.wallet.mwa.AgentMwaSigningResult
import com.agentic.wallet.mwa.MwaController
import com.agentic.wallet.mwa.MwaOperationException
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.FileNotFoundException
import java.security.MessageDigest

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var mwaController: MwaController

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mwaController = MwaController(applicationContext, defaultMwaIdentity())
        AgentMwaLog.info(
            "MainActivity",
            "onCreate",
            "START",
            "bundled Android app shell launched",
            mapOf("exampleTab" to BuildConfig.AGENTIC_ANDROID_SHOW_EXAMPLE_TAB),
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
            private const val MAX_PAYLOAD_CHARS = 2_000_000
        }
    }

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
