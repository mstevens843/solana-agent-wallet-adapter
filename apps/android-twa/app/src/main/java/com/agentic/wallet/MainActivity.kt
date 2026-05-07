package com.agentic.wallet

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
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
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

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
        dispatchMwaCallback("resolve", requestId, payload)
    }

    private fun rejectMwaRequest(requestId: String, err: Throwable) {
        val code = if (err is MwaOperationException) err.code else "WALLET_ERROR"
        val message = err.message ?: err.javaClass.simpleName
        dispatchMwaCallback(
            "reject",
            requestId,
            JSONObject()
                .put("code", code)
                .put("message", message),
        )
    }

    private fun dispatchMwaCallback(callback: String, requestId: String, payload: JSONObject) {
        val js =
            "(function(){var b=window.__agenticAndroidMwaBridge;if(b&&b.$callback){b.$callback(${JSONObject.quote(requestId)},$payload);}})();"
        webView.evaluateJavascript(js, null)
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
        fun mwaRequest(requestId: String, method: String, payloadJson: String) {
            activity.lifecycleScope.launch {
                try {
                    val payload = payloadObject(payloadJson)
                    val result = handleMwaRequest(method, payload)
                    activity.resolveMwaRequest(requestId, result)
                } catch (err: Throwable) {
                    AgentMwaLog.warn(
                        "MainActivity",
                        "mwaRequest",
                        "FAIL",
                        "android js bridge request failed",
                        mapOf("method" to method, "class" to err.javaClass.simpleName, "message" to err.message),
                    )
                    activity.rejectMwaRequest(requestId, err)
                }
            }
        }

        private suspend fun handleMwaRequest(method: String, payload: JSONObject): JSONObject =
            when (method) {
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
            return json
        }

        private fun payloadObject(payloadJson: String): JSONObject =
            if (payloadJson.isBlank()) JSONObject() else JSONObject(payloadJson)

        private fun clusterFromPayload(payload: JSONObject): AgentCluster =
            AgentCluster.requireSupported(payload.optString("cluster", "devnet"))

        private fun bridgeRequestFromPayload(payload: JSONObject): AgentMwaBridgeRequest {
            val signingPayload = payload.optJSONObject("payload") ?: JSONObject()
            val display = payload.optJSONObject("display")
            return AgentMwaBridgeRequest(
                id = payload.optString("id", ""),
                kind = payload.optString("kind", ""),
                payloadData = signingPayload.optString("data", ""),
                payloadEncoding = signingPayload.optString("encoding", "base64"),
                cluster = AgentCluster.requireSupported(payload.optString("cluster", "devnet")),
                summary = display?.optString("summary")?.takeIf { it.isNotBlank() },
            )
        }

        private fun signingResultJson(result: AgentMwaSigningResult): JSONObject {
            val json = JSONObject().put("signature", result.signature)
            if (result.txid != null) {
                json.put("txid", result.txid)
            }
            return json
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
    }
}
