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
import androidx.webkit.WebViewAssetLoader
import com.agentic.wallet.mwa.AgentMwaLog
import java.io.FileNotFoundException

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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

    private class AndroidBridge(private val context: Context) {
        @JavascriptInterface
        fun openMwaExample() {
            val intent = Intent(context, MwaExampleActivity::class.java)
            context.startActivity(intent)
        }

        @JavascriptInterface
        fun isExampleTabEnabled(): Boolean = BuildConfig.AGENTIC_ANDROID_SHOW_EXAMPLE_TAB
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
        private const val LOCAL_APP_START_URL = "https://agentic.local/app"
    }
}
