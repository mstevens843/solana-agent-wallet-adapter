package com.agentic.wallet

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.Manifest
import android.content.pm.PackageManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.fragment.app.FragmentActivity
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.lifecycle.lifecycleScope
import com.agentic.wallet.agent.AgentRuntimeController
import com.agentic.wallet.push.AgenticPushMessagingService
import com.agentic.wallet.agent.StreamingVoucherWorker
import com.agentic.wallet.agent.provider.DeviceAgentProviderExecutor
import com.agentic.wallet.agent.bridge.BridgeAiClient
import com.agentic.wallet.agent.bridge.BridgeE2ee
import com.agentic.wallet.agent.bridge.BridgePairing
import com.agentic.wallet.agent.bridge.BridgePairingStore
import com.agentic.wallet.agent.bridge.BridgeRelayPolicy
import com.agentic.wallet.agent.bridge.BridgeRelayProvider
import com.agentic.wallet.agent.bridge.DefaultBridgeRelayTransport
import com.agentic.wallet.agent.runtime.RuntimeMethod
import com.agentic.wallet.agent.runtime.RuntimeRequest
import com.agentic.wallet.agent.runtime.RuntimeResult
import com.agentic.wallet.config.RemoteConfigLoader
import com.agentic.wallet.mwa.AgentCluster
import com.agentic.wallet.system.BiometricBridge
import com.agentic.wallet.system.SystemBridge
import com.agentic.wallet.mwa.AgentMwaAuthRecord
import com.agentic.wallet.mwa.AgentMwaBridgeRequest
import com.agentic.wallet.mwa.AgentMwaIdentity
import com.agentic.wallet.mwa.AgentMwaLog
import com.agentic.wallet.mwa.AgentMwaSigningResult
import com.agentic.wallet.mwa.MwaIdentityPreflight
import com.agentic.wallet.mwa.MwaController
import com.agentic.wallet.mwa.MwaOperationException
import com.agentic.wallet.mwa.WalletRegistry
import com.agentic.wallet.streaming.StreamingSessionException
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.FileNotFoundException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference

// Inherits from FragmentActivity (not ComponentActivity) because androidx.biometric
// BiometricPrompt requires a FragmentActivity host. FragmentActivity extends
// ComponentActivity, so lifecycleScope / ActivityResultSender / lifecycle.currentState
// still work as before. Do not downgrade to ComponentActivity without first removing
// or refactoring BiometricBridge.
class MainActivity : FragmentActivity() {
    private lateinit var webView: WebView
    private lateinit var mwaController: MwaController
    private lateinit var secureStore: NativeSecureStore
    private lateinit var agentRuntimeController: AgentRuntimeController
    // Phone↔desktop "use your plan from your computer" pairing state. The claim is a network call
    // run off the binder thread in lifecycleScope; JS polls bridgePairStatus() for the outcome.
    private lateinit var bridgePairingStore: BridgePairingStore
    private lateinit var bridgeAiClient: BridgeAiClient
    @Volatile private var bridgePairInProgress: Boolean = false
    @Volatile private var bridgePairLastError: String? = null
    // Last-known relay/desktop reachability, refreshed asynchronously by bridgeRelayStatus() so the
    // JS status chip can show "computer online/offline" without a blocking binder-thread network call.
    @Volatile private var relayDesktopOnline: Boolean = false
    @Volatile private var relayProbeInFlight: Boolean = false
    // Held across the OS camera-permission dialog so the WebView's getUserMedia request can be
    // granted once the user approves (QR scanner for desktop pairing).
    private var pendingCameraPermissionRequest: PermissionRequest? = null
    private var pendingQrScannerRequestId: String? = null
    private lateinit var qrScannerLauncher: ActivityResultLauncher<Intent>
    private lateinit var activityResultSender: ActivityResultSender
    private lateinit var systemBridge: SystemBridge
    private lateinit var biometricBridge: BiometricBridge

    private val remoteWebUrl: String = BuildConfig.AGENTIC_ANDROID_REMOTE_WEB_URL
    private val remoteWebHost: String? = remoteWebUrl
        .takeIf { it.isNotBlank() }
        ?.let { runCatching { Uri.parse(it).host?.lowercase() }.getOrNull() }
    private var didFallback = false
    // Monotonic timestamp (elapsedRealtime) of the last bundled fallback, so onResume
    // can retry the live URL after a cooldown instead of stranding the user on the
    // stale baked-in bundle for the whole session after a transient remote failure.
    private var fallbackAt = 0L
    // Set by the render-process-gone recovery just before recreate(): the WebView is dead, so
    // onSaveInstanceState must NOT persist its (broken) state. Resets on the fresh instance.
    private var suppressWebViewStateSave = false

    // Top-frame URL cache for the origin guard. WebView.getUrl() is UI-thread only and
    // throws RuntimeException when called from the WebView's @JavascriptInterface JS
    // thread; that throw used to surface as "Java exception was raised during method
    // invocation" on every bridge call. We snapshot the URL from the UI thread inside
    // WebViewClient callbacks and have isCurrentOriginAllowed() read this reference.
    private val currentWebViewOrigin = AtomicReference<String?>(null)
    @Volatile private var keyboardInsetCssPx: Int = 0
    @Volatile private var keyboardVisible: Boolean = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // CRITICAL: ActivityResultSender must be constructed BEFORE the activity reaches STARTED.
        // Its constructor calls registerForActivityResult(), which Android refuses past STARTED.
        // See KNOWN_ISSUES.md "ActivityResultSender lifecycle violation" in grant-godot.
        activityResultSender = ActivityResultSender(this)
        qrScannerLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            handleQrScannerResult(result.resultCode, result.data)
        }
        mwaController = MwaController(applicationContext, defaultMwaIdentity())
        secureStore = NativeSecureStore(applicationContext)
        bridgePairingStore = BridgePairingStore(secureStore)
        bridgeAiClient = BridgeAiClient(DefaultBridgeRelayTransport(), bridgePairingStore)
        RemoteConfigLoader.initialize(BuildConfig.AGENTIC_ANDROID_CLOUD_API_BASE_URL, secureStore)
        RemoteConfigLoader.refresh(lifecycleScope)
        systemBridge = SystemBridge(this)
        biometricBridge = BiometricBridge(this)
        agentRuntimeController = AgentRuntimeController(applicationContext, secureStore)
        if (BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) {
            // Inject the relay provider so a paired-bridge config routes to the user's own desktop
            // connector (Codex/Claude) instead of an on-device API key.
            agentRuntimeController.setProviderExecutor(
                DeviceAgentProviderExecutor(bridgeRelayProvider = BridgeRelayProvider(bridgeAiClient)),
            )
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

                // The in-app QR scanner (desktop pairing) calls getUserMedia. Grant the camera to
                // our own bundled origin only; everything else is denied. Falls back to "paste the
                // code" in the WebView when the OS camera permission isn't held.
                override fun onPermissionRequest(request: PermissionRequest) {
                    val wantsCamera = request.resources.any { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }
                    val originAllowed = isAllowedInWebView(request.origin)
                    if (!wantsCamera || !originAllowed) {
                        request.deny()
                        return
                    }
                    runOnUiThread { handleCameraPermissionRequest(request) }
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

                override fun onRenderProcessGone(
                    view: WebView,
                    detail: android.webkit.RenderProcessGoneDetail,
                ): Boolean = handleRenderProcessGone(view, detail)
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        setContentView(webView)
        applySystemBarInsets(webView)

        val startUrl = if (remoteWebUrl.isNotBlank()) remoteWebUrl else LOCAL_APP_START_URL
        // Seed the origin cache before loadUrl returns. onPageStarted will overwrite this
        // once the page actually loads, but bridge calls during early page bootstrap need
        // a non-null value to satisfy the origin guard.
        currentWebViewOrigin.set(startUrl)
        // Restore WebView state only for the bundled local shell. Release builds that live-load
        // Render must always navigate to the remote start URL on Activity creation; restoring a
        // saved remote document can keep old JS alive after a Render deploy.
        val restoredLocalState = shouldRestoreSavedWebViewState(remoteWebUrl, savedInstanceState != null) &&
            webView.restoreState(savedInstanceState!!) != null
        AgentMwaLog.info(
            "MainActivity",
            "onCreate",
            if (restoredLocalState) "RESTORE_LOCAL_STATE" else "LOAD_START_URL",
            "webview startup navigation resolved",
            mapOf(
                "remoteWebUrl" to remoteWebUrl,
                "restoredLocalState" to restoredLocalState,
                "savedInstanceState" to (savedInstanceState != null),
                "startUrl" to startUrl,
            ),
        )
        if (!restoredLocalState) {
            webView.loadUrl(startUrl)
        }
        // Buffer a cold-launch notification tap (the SPA drains it via consumePushRoute once loaded).
        deliverPushRouteFromIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // Persist the WebView's navigation state so a process-death recreation can restore it
        // (and so restoreState() above has something to return); the guard avoids touching the
        // lateinit WebView if onCreate failed before it was built.
        // suppressWebViewStateSave is set by the render-process-gone recovery: the WebView is dead,
        // so saving its state would persist a broken snapshot (and can throw on a destroyed view).
        if (::webView.isInitialized && !suppressWebViewStateSave && remoteWebUrl.isBlank()) {
            webView.saveState(outState)
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

    // The WebView's renderer process can be killed independently of our app process (system memory
    // reclaim while backgrounded, or a renderer crash). The dead WebView can never be reused; left
    // unhandled the framework leaves a black surface or tears the whole app down. Recreate the
    // Activity so onCreate builds a fresh WebView and reloads the start URL. A short throttle stops
    // a crash→recreate→crash loop: if the renderer dies again within the window we stop auto-
    // recovering (degrades to the pre-fix behavior, never worse) but still return true so the app
    // process survives.
    private fun handleRenderProcessGone(
        view: WebView,
        detail: android.webkit.RenderProcessGoneDetail,
    ): Boolean {
        val crashed = detail.didCrash()
        val isCurrent = view === webView
        AgentMwaLog.warn(
            "MainActivity",
            "onRenderProcessGone",
            "WEBVIEW_RENDER_GONE",
            if (crashed) "WebView render process crashed" else "WebView render process reclaimed by system",
            mapOf("didCrash" to crashed, "isCurrent" to isCurrent),
        )
        (view.parent as? android.view.ViewGroup)?.removeView(view)
        if (!isCurrent || isFinishing || isDestroyed) {
            view.destroy()
            return true
        }
        val now = android.os.SystemClock.elapsedRealtime()
        val looping = lastRenderRecoveryAt != 0L &&
            now - lastRenderRecoveryAt < RENDER_RECOVERY_MIN_INTERVAL_MS
        lastRenderRecoveryAt = now
        view.destroy()
        if (!looping) {
            // Skip persisting the dead WebView during the recreate save pass; onCreate then takes
            // the "nothing to restore → loadUrl" path and reloads the start URL cleanly.
            suppressWebViewStateSave = true
            recreate()
        }
        return true
    }

    private fun maybeFallbackToBundled(view: WebView, request: WebResourceRequest, reason: String) {
        if (didFallback) return
        if (!request.isForMainFrame) return
        if (remoteWebHost == null) return
        val host = request.url?.host?.lowercase() ?: return
        if (host != remoteWebHost) return
        didFallback = true
        fallbackAt = android.os.SystemClock.elapsedRealtime()
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

    override fun onPause() {
        if (::mwaController.isInitialized) {
            mwaController.notifyActivityPaused()
        }
        super.onPause()
    }

    override fun onStop() {
        if (::mwaController.isInitialized) {
            mwaController.notifyActivityStopped()
        }
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        // Recover from a transient remote failure: if we fell back to the bundled
        // (stale) UI but the cooldown has elapsed, retry the live Render URL so the
        // user isn't stranded on baked-in assets for the rest of the session once
        // connectivity returns. If the remote is still down, maybeFallbackToBundled
        // simply falls back again (no churn — gated by cooldown + a foreground event).
        if (didFallback &&
            remoteWebUrl.isNotBlank() &&
            ::webView.isInitialized &&
            android.os.SystemClock.elapsedRealtime() - fallbackAt >= REMOTE_RETRY_COOLDOWN_MS
        ) {
            didFallback = false
            currentWebViewOrigin.set(remoteWebUrl)
            webView.loadUrl(remoteWebUrl)
        }
        if (!didFallback && shouldReloadRemoteFromCurrentUrl()) {
            AgentMwaLog.info(
                "MainActivity",
                "onResume",
                "REMOTE_RELOAD",
                "foregrounded on bundled or stale webview URL; reloading live Render shell",
                mapOf(
                    "remoteWebUrl" to remoteWebUrl,
                    "currentUrl" to currentWebViewOrigin.get().orEmpty(),
                ),
            )
            currentWebViewOrigin.set(remoteWebUrl)
            webView.loadUrl(remoteWebUrl)
        }
        // Debounced inside the loader, so onResume → onResume churn doesn't spam the
        // network. Forces a fetch when the app is foregrounded after >60s in background.
        RemoteConfigLoader.refresh(lifecycleScope)
        // Watchdog: if onResume fires while an MWA call is suspended and the activity stays
        // RESUMED past the grace window, the user dismissed the OS chooser without picking a
        // wallet — cancel the suspended call so the JS busy flag releases.
        mwaController.notifyActivityResumed(this)
    }

    private fun shouldReloadRemoteFromCurrentUrl(): Boolean {
        if (remoteWebUrl.isBlank() || !::webView.isInitialized) return false
        val current = currentWebViewOrigin.get() ?: webView.url ?: return true
        return shouldReloadRemoteFromWebViewUrl(remoteWebUrl, remoteWebHost, current)
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

    /** True when debug builds expose Plan Connector locally or release config enables it remotely. */
    private fun bridgePairingFeatureEnabled(): Boolean =
        BuildConfig.DEBUG || RemoteConfigLoader.current().config.featureFlags["bridgePairingEnabled"] == true

    /**
     * Validate a scanned/pasted pairing payload and start the claim asynchronously. The relay host
     * is checked against the pinned allowlist BEFORE any token leaves the device. Returns an
     * immediate status; the actual network claim runs in lifecycleScope and updates state polled
     * via [bridgePairStatusJson].
     */
    private fun startBridgePairing(payloadJson: String): JSONObject {
        if (!bridgePairingFeatureEnabled()) {
            AgentMwaLog.warn(
                "MainActivity",
                "startBridgePairing",
                "NOT_ENABLED",
                "pairing payload rejected because feature is disabled",
                mapOf("payloadBytes" to payloadJson.toByteArray(Charsets.UTF_8).size),
            )
            return JSONObject().put("ok", false).put("error", "not_enabled")
        }
        // Reject re-entry: a second concurrent claim would race the in-progress flag and make
        // bridgePairStatus() report "not pairing" prematurely (JS polls it as source of truth).
        if (bridgePairInProgress) {
            AgentMwaLog.warn(
                "MainActivity",
                "startBridgePairing",
                "ALREADY_PAIRING",
                "pairing payload rejected because another claim is in flight",
                mapOf("payloadBytes" to payloadJson.toByteArray(Charsets.UTF_8).size),
            )
            return JSONObject().put("ok", false).put("error", "already_pairing")
        }
        val payload = try {
            JSONObject(payloadJson)
        } catch (err: Throwable) {
            AgentMwaLog.warn(
                "MainActivity",
                "startBridgePairing",
                "BAD_JSON",
                "pairing payload was not valid JSON",
                mapOf(
                    "payloadBytes" to payloadJson.toByteArray(Charsets.UTF_8).size,
                    "class" to err.javaClass.simpleName,
                ),
            )
            return JSONObject().put("ok", false).put("error", "bad_payload")
        }
        val relay = payload.optString("relay", "").trim()
        val uuid = payload.optString("uuid", "").trim()
        val token = payload.optString("token", "").trim()
        val version = payload.optInt("v", 1)
        val tag = bridgePairTag(uuid)
        val e2eeQr = try {
            BridgeE2ee.parseQr(payload.optJSONObject("e2ee"))
        } catch (err: Throwable) {
            AgentMwaLog.warn(
                "MainActivity",
                "startBridgePairing",
                "BAD_E2EE",
                "pairing payload encrypted setup was invalid",
                mapOf("tag" to tag, "version" to version, "class" to err.javaClass.simpleName),
            )
            return JSONObject().put("ok", false).put("error", "bad_payload")
        }
        AgentMwaLog.info(
            "MainActivity",
            "startBridgePairing",
            "PARSED",
            "pairing payload parsed",
            mapOf(
                "tag" to tag,
                "version" to version,
                "relayHost" to relayHostForLog(relay),
                "hasRelay" to relay.isNotEmpty(),
                "hasUuid" to uuid.isNotEmpty(),
                "hasToken" to token.isNotEmpty(),
                "hasE2ee" to (e2eeQr != null),
                "payloadBytes" to payloadJson.toByteArray(Charsets.UTF_8).size,
            ),
        )
        if (version <= 0) {
            AgentMwaLog.warn(
                "MainActivity",
                "startBridgePairing",
                "BAD_VERSION",
                "pairing payload version was invalid",
                mapOf("tag" to tag, "version" to version),
            )
            return JSONObject().put("ok", false).put("error", "bad_payload")
        }
        if (version >= 2 && e2eeQr == null) {
            AgentMwaLog.warn(
                "MainActivity",
                "startBridgePairing",
                "E2EE_REQUIRED",
                "v2 pairing payload omitted encrypted setup",
                mapOf("tag" to tag, "version" to version),
            )
            return JSONObject().put("ok", false).put("error", "e2ee_required")
        }
        if (relay.isEmpty() || uuid.isEmpty() || token.isEmpty()) {
            AgentMwaLog.warn(
                "MainActivity",
                "startBridgePairing",
                "INCOMPLETE",
                "pairing payload omitted required fields",
                mapOf(
                    "tag" to tag,
                    "hasRelay" to relay.isNotEmpty(),
                    "hasUuid" to uuid.isNotEmpty(),
                    "hasToken" to token.isNotEmpty(),
                ),
            )
            return JSONObject().put("ok", false).put("error", "incomplete_payload")
        }
        if (!BridgeRelayPolicy.isAllowedRelay(relay)) {
            AgentMwaLog.warn(
                "MainActivity",
                "startBridgePairing",
                "RELAY_REJECTED",
                "relay host not allowlisted",
                mapOf("tag" to tag, "relayHost" to relayHostForLog(relay)),
            )
            return JSONObject().put("ok", false).put("error", "relay_not_allowed")
        }
        bridgePairLastError = null
        bridgePairInProgress = true
        AgentMwaLog.info(
            "MainActivity",
            "startBridgePairing",
            "CLAIM_START",
            "pairing claim launched",
            mapOf("tag" to tag, "relayHost" to relayHostForLog(relay), "hasE2ee" to (e2eeQr != null)),
        )
        lifecycleScope.launch {
            try {
                val claim = bridgeAiClient.claim(relay, uuid, token, e2eeQr)
                bridgePairingStore.save(BridgePairing(relayBaseUrl = relay, pairUuid = uuid, deviceBearer = claim.deviceBearer, e2ee = claim.e2ee))
                AgentMwaLog.info(
                    "MainActivity",
                    "startBridgePairing",
                    "PAIRED",
                    "phone paired to desktop",
                    mapOf("tag" to tag, "relayHost" to relayHostForLog(relay), "hasE2ee" to (claim.e2ee != null)),
                )
            } catch (err: Throwable) {
                bridgePairLastError = err.message ?: "Pairing failed."
                AgentMwaLog.failure(
                    "MainActivity",
                    "startBridgePairing",
                    "FAIL",
                    "pairing claim failed",
                    err,
                    mapOf("tag" to tag, "relayHost" to relayHostForLog(relay)),
                )
            } finally {
                bridgePairInProgress = false
            }
        }
        return JSONObject().put("ok", true).put("status", "pairing")
    }

    private fun bridgePairStatusJson(): JSONObject =
        JSONObject()
            .put("paired", bridgePairingStore.isPaired())
            .put("pairing", bridgePairInProgress)
            .put("enabled", bridgePairingFeatureEnabled())
            .put("error", bridgePairLastError ?: JSONObject.NULL)

    /** Returns {paired, desktopOnline} from the last async probe and triggers a fresh one. Never
     *  blocks the binder thread on the network. */
    private fun bridgeRelayStatusJson(): JSONObject {
        val paired = bridgePairingStore.isPaired()
        if (paired) {
            // De-dup: only one probe in flight at a time, so a slow relay + frequent polling doesn't
            // stack identical GETs.
            if (!relayProbeInFlight) {
                relayProbeInFlight = true
                lifecycleScope.launch {
                    try {
                        val status = bridgeAiClient.status()
                        if (!status.paired) {
                            bridgePairingStore.clear()
                            relayDesktopOnline = false
                        } else {
                            relayDesktopOnline = status.desktopOnline
                        }
                    } catch (_: Throwable) {
                        // keep last-known value; a blip shouldn't flip the chip to offline
                    } finally {
                        relayProbeInFlight = false
                    }
                }
            }
        } else {
            relayDesktopOnline = false
        }
        return JSONObject().put("paired", paired).put("desktopOnline", relayDesktopOnline)
    }

    private fun clearBridgePairing(): JSONObject {
        val pairing = bridgePairingStore.current()
        bridgePairingStore.clear()
        bridgePairLastError = null
        bridgePairInProgress = false
        if (pairing != null) {
            lifecycleScope.launch {
                try {
                    bridgeAiClient.unpair(pairing)
                } catch (err: Throwable) {
                    AgentMwaLog.warn("MainActivity", "clearBridgePairing", "RELAY_UNPAIR_FAILED", err.message ?: "relay unpair failed", emptyMap())
                }
            }
        }
        AgentMwaLog.info("MainActivity", "clearBridgePairing", "UNPAIRED", "phone unpaired", emptyMap())
        return JSONObject().put("ok", true)
    }

    /** Grant the WebView's camera request if we hold the OS permission, else request it and grant
     *  on approval (the held [PermissionRequest] stays valid until granted/denied). */
    private fun handleCameraPermissionRequest(request: PermissionRequest) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            AgentMwaLog.info(
                "MainActivity",
                "handleCameraPermissionRequest",
                "GRANT_EXISTING",
                "granting WebView camera request with existing OS permission",
                mapOf("origin" to request.origin.toString()),
            )
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            return
        }
        // Deny any prior in-flight request before overwriting so a stale request (pointing at a dead
        // WebView) is never left hanging.
        pendingCameraPermissionRequest?.deny()
        pendingCameraPermissionRequest = request
        AgentMwaLog.info(
            "MainActivity",
            "handleCameraPermissionRequest",
            "REQUEST_OS_PERMISSION",
            "requesting OS camera permission for WebView camera request",
            mapOf("origin" to request.origin.toString()),
        )
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST_CODE)
    }

    override fun onDestroy() {
        // If the activity is destroyed while the OS camera dialog is up, deny the held request — it
        // points at a WebView that's going away; the recreated activity's WebView re-issues if needed.
        pendingCameraPermissionRequest?.deny()
        pendingCameraPermissionRequest = null
        pendingQrScannerRequestId = null
        super.onDestroy()
    }

    // ── Push notifications (POST_NOTIFICATIONS runtime request + FCM token) ──────────────────────
    // The one piece that genuinely requires a new APK: nothing here ever requested POST_NOTIFICATIONS,
    // and with targetSdk 36, declaring it in the manifest is not enough — Android 13+ suppresses every
    // notification until it's granted at runtime, so SystemBridge.showNotification returned
    // permission_not_granted on every modern device.

    private var pendingPushRequestId: String? = null
    // A tap route that arrived before the SPA installed its push bridge (cold launch). Held until the
    // JS layer calls consumePushRoute() on init — the Android analogue of the iOS tap buffer.
    private var pendingPushRoute: String? = null

    /**
     * A notification tap launched (or re-focused) us with a route extra. Deliver it to JS via the push
     * bridge if it's listening (warm re-focus); otherwise buffer for consumePushRoute() (cold launch).
     */
    private fun deliverPushRouteFromIntent(intent: Intent?) {
        val route = intent?.getStringExtra(AgenticPushMessagingService.EXTRA_PUSH_ROUTE) ?: return
        // Clear it so a config-change relaunch (rotation) can't replay the same tap.
        intent.removeExtra(AgenticPushMessagingService.EXTRA_PUSH_ROUTE)
        pendingPushRoute = route
        webView.post {
            val js =
                "(function(){var b=window.__agenticAndroidPushBridge;if(b&&b.onTap){b.onTap($route);}})();"
            webView.evaluateJavascript(js, null)
        }
    }

    /** Drained by the SPA on init to pick up a cold-launch tap. Returns "{}" when there's none. */
    fun consumePushRouteJson(): String {
        val route = pendingPushRoute ?: return "{}"
        pendingPushRoute = null
        return route
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deliverPushRouteFromIntent(intent)
    }

    fun requestPushPermissionAndToken(requestId: String) {
        val alreadyGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (alreadyGranted) {
            resolvePushWithToken(requestId, "granted")
            return
        }
        pendingPushRequestId = requestId
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            NOTIFICATION_PERMISSION_REQUEST_CODE,
        )
    }

    /** Fetch the FCM token, then resolve the JS bridge with { ok, status, token }. */
    private fun resolvePushWithToken(requestId: String, status: String) {
        AgenticPushMessagingService.fetchToken { token ->
            runOnUiThread {
                val envelope = JSONObject()
                    .put("ok", token != null)
                    .put("status", status)
                    .put("platform", "android")
                if (token != null) envelope.put("token", token) else envelope.put("message", "fcm_token_unavailable")
                dispatchPushResult(requestId, envelope)
            }
        }
    }

    private fun dispatchPushResult(requestId: String, envelope: JSONObject) {
        if (isDestroyed) return
        val js =
            "(function(){var b=window.__agenticAndroidPushBridge;if(b&&b.resolve){b.resolve(${JSONObject.quote(requestId)},$envelope);}})();"
        webView.evaluateJavascript(js, null)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST_CODE) {
            val requestId = pendingPushRequestId
            pendingPushRequestId = null
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            if (requestId != null) {
                if (granted) {
                    resolvePushWithToken(requestId, "granted")
                } else {
                    dispatchPushResult(requestId, JSONObject().put("ok", false).put("status", "denied"))
                }
            }
            return
        }
        if (requestCode != CAMERA_PERMISSION_REQUEST_CODE) return
        val pending = pendingCameraPermissionRequest
        pendingCameraPermissionRequest = null
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        AgentMwaLog.info(
            "MainActivity",
            "onRequestPermissionsResult",
            if (granted) "GRANTED" else "DENIED",
            "WebView camera permission result received",
            mapOf("granted" to granted, "hadPendingRequest" to (pending != null)),
        )
        if (granted) {
            pending?.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            pending?.deny()
        }
    }

    private fun startPairingQrScanner(requestId: String) {
        AgentMwaLog.info(
            "MainActivity",
            "bridgeScanPairingQr",
            "QUEUE_LAUNCH",
            "posting QR scanner launch to UI thread",
            mapOf("requestId" to requestId),
        )
        runOnUiThread {
            if (pendingQrScannerRequestId != null) {
                AgentMwaLog.warn(
                    "MainActivity",
                    "bridgeScanPairingQr",
                    "SCANNER_BUSY",
                    "QR scanner launch rejected because another scan is pending",
                    mapOf("requestId" to requestId, "pendingRequestId" to pendingQrScannerRequestId),
                )
                dispatchQrScannerResult(
                    "resolve",
                    requestId,
                    JSONObject().put("ok", false).put("error", "scanner_busy"),
                )
                return@runOnUiThread
            }
            pendingQrScannerRequestId = requestId
            try {
                AgentMwaLog.info(
                    "MainActivity",
                    "bridgeScanPairingQr",
                    "LAUNCH",
                    "launching QR scanner activity",
                    mapOf("requestId" to requestId),
                )
                qrScannerLauncher.launch(Intent(this, QrScannerActivity::class.java))
            } catch (err: Throwable) {
                pendingQrScannerRequestId = null
                AgentMwaLog.failure(
                    "MainActivity",
                    "bridgeScanPairingQr",
                    "LAUNCH_FAILED",
                    "failed to launch QR scanner",
                    err,
                    mapOf("requestId" to requestId),
                )
                dispatchQrScannerResult(
                    "resolve",
                    requestId,
                    JSONObject().put("ok", false).put("error", "camera_unavailable"),
                )
            }
        }
    }

    private fun handleQrScannerResult(resultCode: Int, data: Intent?) {
        val requestId = pendingQrScannerRequestId
        if (requestId == null) {
            AgentMwaLog.warn(
                "MainActivity",
                "handleQrScannerResult",
                "MISSING_REQUEST",
                "QR scanner result arrived without a pending request",
                mapOf("resultCode" to resultCode),
            )
            return
        }
        pendingQrScannerRequestId = null
        val rawValue = data?.getStringExtra(QrScannerActivity.EXTRA_RAW_VALUE).orEmpty()
        AgentMwaLog.info(
            "MainActivity",
            "handleQrScannerResult",
            "START",
            "QR scanner result received",
            mapOf(
                "requestId" to requestId,
                "resultCode" to resultCode,
                "hasRawValue" to rawValue.isNotBlank(),
                "error" to data?.getStringExtra(QrScannerActivity.EXTRA_ERROR).orEmpty(),
            ),
        )
        if (resultCode == RESULT_OK && rawValue.isNotBlank()) {
            dispatchQrScannerResult(
                "resolve",
                requestId,
                JSONObject().put("ok", true).put("rawValue", rawValue),
            )
            return
        }
        val error = data?.getStringExtra(QrScannerActivity.EXTRA_ERROR).orEmpty().ifBlank { "cancelled" }
        dispatchQrScannerResult(
            "resolve",
            requestId,
            JSONObject().put("ok", false).put("error", error),
        )
    }

    private fun dispatchQrScannerResult(callback: String, requestId: String, envelope: JSONObject) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            AgentMwaLog.info(
                "MainActivity",
                "dispatchQrScannerResult",
                "QUEUE_UI",
                "queueing QR scanner callback on UI thread",
                mapOf(
                    "callback" to callback,
                    "requestId" to requestId,
                    "ok" to envelope.optBoolean("ok", false),
                    "error" to envelope.optString("error", ""),
                ),
            )
            runOnUiThread { dispatchQrScannerResult(callback, requestId, envelope) }
            return
        }
        if (isDestroyed) {
            AgentMwaLog.warn(
                "MainActivity",
                "dispatchQrScannerResult",
                "SKIP_DESTROYED",
                "QR scanner callback skipped because activity is destroyed",
                mapOf("callback" to callback, "requestId" to requestId),
            )
            return
        }
        val js =
            "(function(){var b=window.__agenticAndroidQrScannerBridge;if(b&&b.$callback){b.$callback(${JSONObject.quote(requestId)},$envelope);}})();"
        AgentMwaLog.info(
            "MainActivity",
            "dispatchQrScannerResult",
            "START",
            "evaluating QR scanner callback",
            mapOf(
                "callback" to callback,
                "requestId" to requestId,
                "ok" to envelope.optBoolean("ok", false),
                "error" to envelope.optString("error", ""),
                "hasRawValue" to envelope.optString("rawValue", "").isNotBlank(),
            ),
        )
        webView.evaluateJavascript(js) { result ->
            AgentMwaLog.info(
                "MainActivity",
                "dispatchQrScannerResult",
                "DONE",
                "QR scanner callback evaluated",
                mapOf("callback" to callback, "requestId" to requestId, "evalResult" to result.orEmpty()),
            )
        }
    }

    // Streaming chat: push one raw provider SSE chunk to JS (the bridge routes it into
    // the active chat-stream sink). MUST run on the UI thread (WebView access).
    fun pushDeviceAgentChatChunk(requestId: String, chunk: String) {
        if (isDestroyed) return
        val js = "(function(){var b=window.__agenticAndroidDeviceAgentBridge;if(b&&b.onChunk){b.onChunk(${JSONObject.quote(requestId)},${JSONObject.quote(chunk)});}})();"
        webView.evaluateJavascript(js, null)
    }

    // Streaming chat: signal end-of-stream so JS closes the synthetic Response stream.
    fun pushDeviceAgentChatStreamEnd(requestId: String) {
        if (isDestroyed) return
        val js = "(function(){var b=window.__agenticAndroidDeviceAgentBridge;if(b&&b.onStreamEnd){b.onStreamEnd(${JSONObject.quote(requestId)});}})();"
        webView.evaluateJavascript(js, null)
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

    internal fun dispatchBiometricResult(requestId: String, envelope: JSONObject) {
        if (isDestroyed) {
            AgentMwaLog.warn(
                "MainActivity",
                "dispatchBiometricResult",
                "ACTIVITY_DESTROYED",
                "skipped biometric resolve on destroyed activity",
                mapOf("requestId" to requestId),
            )
            return
        }
        val js =
            "(function(){var b=window.__agenticAndroidBiometricBridge;if(b&&b.resolve){b.resolve(${JSONObject.quote(requestId)},$envelope);}})();"
        AgentMwaLog.info(
            "MainActivity",
            "dispatchBiometricResult",
            "START",
            "evaluating biometric resolve callback",
            mapOf(
                "requestId" to requestId,
                "ok" to envelope.optBoolean("ok", false),
                "kind" to envelope.optString("kind", ""),
            ),
        )
        webView.evaluateJavascript(js) { result ->
            AgentMwaLog.info(
                "MainActivity",
                "dispatchBiometricResult",
                "DONE",
                "biometric resolve callback evaluated",
                mapOf("requestId" to requestId, "evalResult" to result.orEmpty()),
            )
        }
    }

    /**
     * Coarse lifecycle name for the JS bridge: "created"|"started"|"resumed"|
     * "paused"|"stopped"|"destroyed". Derived from
     * [lifecycle.currentState][androidx.lifecycle.Lifecycle.State].
     */
    internal fun currentLifecycleState(): String {
        return when (lifecycle.currentState) {
            androidx.lifecycle.Lifecycle.State.RESUMED -> "resumed"
            androidx.lifecycle.Lifecycle.State.STARTED -> "started"
            androidx.lifecycle.Lifecycle.State.CREATED -> "created"
            androidx.lifecycle.Lifecycle.State.INITIALIZED -> "initialized"
            androidx.lifecycle.Lifecycle.State.DESTROYED -> "destroyed"
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
            updateKeyboardInsets(insets)
            target.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }

    private fun keyboardInsetsJson(): JSONObject =
        JSONObject()
            .put("keyboardInset", keyboardInsetCssPx)
            .put("visible", keyboardVisible)

    private fun updateKeyboardInsets(insets: WindowInsetsCompat) {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
        val density = resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
        val insetPx = if (imeVisible) maxOf(0, ime.bottom - bars.bottom) else 0
        val insetCssPx = (insetPx / density).toInt()
        val visible = imeVisible && insetCssPx > 0
        if (keyboardInsetCssPx == insetCssPx && keyboardVisible == visible) return
        keyboardInsetCssPx = insetCssPx
        keyboardVisible = visible
        dispatchKeyboardInsetsToWebView()
    }

    private fun dispatchKeyboardInsetsToWebView() {
        if (!::webView.isInitialized) return
        val payload = keyboardInsetsJson().toString()
        val js = """
            (function(){
              var bridge = window.__agenticAndroidKeyboardInsetBridge;
              if (bridge && typeof bridge.update === 'function') {
                bridge.update($payload);
              }
            })();
        """.trimIndent()
        webView.post {
            webView.evaluateJavascript(js, null)
        }
    }

    private class AndroidBridge(private val activity: MainActivity) {
        // The in-flight streaming-chat coroutine, tracked so a JS 'cancelStream' (Stop
        // mid-stream) can cancel it → the streaming HttpURLConnection disconnects.
        @Volatile private var activeStreamJob: Job? = null

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
        fun appRuntimeInfo(): String = safeBridge("appRuntimeInfo", "{}") {
            if (!checkTrustedOrigin("appRuntimeInfo")) return@safeBridge "{}"
            JSONObject()
                .put("platform", "android")
                .put("versionName", BuildConfig.VERSION_NAME)
                .put("versionCode", BuildConfig.VERSION_CODE)
                .put("debug", BuildConfig.DEBUG)
                .put("releaseProfile", BuildConfig.AGENTIC_ANDROID_RELEASE_PROFILE)
                .put("remoteWebUrl", BuildConfig.AGENTIC_ANDROID_REMOTE_WEB_URL)
                .put("cloudApiBaseUrl", BuildConfig.AGENTIC_ANDROID_CLOUD_API_BASE_URL)
                .put("keyboardInsetsBridge", true)
                // Advertises that this binary has the runtime POST_NOTIFICATIONS request + FCM token
                // bridge. Live JS gates the notification card's push path on this AND a server flag
                // (the "two flags must agree" shape), so a new web bundle stays silent on an old APK
                // that lacks these methods rather than showing a permanently-failing button.
                .put("notificationsBridge", true)
                .put("webFallbackEnabled", BuildConfig.AGENTIC_ANDROID_ENABLE_WEB_FALLBACK)
                .put("deviceAgentEnabled", BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT)
                .toString()
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
        fun keyboardInsets(): String = safeBridge("keyboardInsets", "{\"keyboardInset\":0,\"visible\":false}") {
            if (!checkTrustedOrigin("keyboardInsets")) return@safeBridge "{\"keyboardInset\":0,\"visible\":false}"
            activity.keyboardInsetsJson().toString()
        }

        // ── Phone↔desktop pairing ("use your ChatGPT/Claude plan from your computer") ──────────
        // Gated by the bridgePairingEnabled remote-config flag (operator dark-launch/kill-switch).
        // The relay URL is carried in the scanned QR and validated against the pinned host
        // allowlist (BridgeRelayPolicy) before any token is claimed.

        @JavascriptInterface
        fun bridgePairEnabled(): Boolean = safeBridge("bridgePairEnabled", false) {
            if (!checkTrustedOrigin("bridgePairEnabled")) return@safeBridge false
            val enabled = activity.bridgePairingFeatureEnabled()
            AgentMwaLog.debug(
                "AndroidBridge",
                "bridgePairEnabled",
                "DONE",
                "bridge pairing feature flag read",
                mapOf("enabled" to enabled),
            )
            enabled
        }

        /**
         * Claim a pairing from a scanned/pasted desktop QR. Payload JSON: { relay, uuid, token }.
         * Validates the relay host, then claims + stores asynchronously (off the binder thread, so a
         * slow relay never ANRs the WebView). Returns an immediate envelope { ok, status, error? };
         * JS polls bridgePairStatus() for the final paired/error outcome.
         */
        @JavascriptInterface
        fun bridgePair(payloadJson: String): String =
            safeBridge("bridgePair", "{\"ok\":false,\"error\":\"bridge_unavailable\"}") {
                if (!checkTrustedOrigin("bridgePair")) return@safeBridge "{\"ok\":false,\"error\":\"origin\"}"
                AgentMwaLog.info(
                    "AndroidBridge",
                    "bridgePair",
                    "START",
                    "pairing payload received from web",
                    mapOf("payloadBytes" to payloadJson.toByteArray(Charsets.UTF_8).size),
                )
                val result = activity.startBridgePairing(payloadJson)
                AgentMwaLog.info(
                    "AndroidBridge",
                    "bridgePair",
                    "DONE",
                    "pairing payload returned immediate status",
                    mapOf(
                        "ok" to result.optBoolean("ok", false),
                        "status" to result.optString("status", ""),
                        "error" to result.optString("error", ""),
                    ),
                )
                result.toString()
            }

        @JavascriptInterface
        fun bridgeScanPairingQr(requestId: String) {
            AgentMwaLog.info(
                "AndroidBridge",
                "bridgeScanPairingQr",
                "START",
                "QR scanner bridge request received",
                mapOf(
                    "requestId" to requestId,
                    "requestIdValid" to REQUEST_ID_PATTERN.matches(requestId),
                ),
            )
            try {
                if (!checkTrustedOrigin("bridgeScanPairingQr")) {
                    AgentMwaLog.warn(
                        "AndroidBridge",
                        "bridgeScanPairingQr",
                        "ORIGIN_DENIED",
                        "QR scanner bridge origin denied",
                        mapOf("requestId" to requestId),
                    )
                    activity.dispatchQrScannerResult(
                        "resolve",
                        requestId,
                        JSONObject().put("ok", false).put("error", "origin"),
                    )
                    return
                }
                if (!REQUEST_ID_PATTERN.matches(requestId)) {
                    AgentMwaLog.warn(
                        "AndroidBridge",
                        "bridgeScanPairingQr",
                        "INVALID_REQUEST",
                        "QR scanner bridge request id rejected",
                        mapOf("requestId" to requestId),
                    )
                    activity.dispatchQrScannerResult(
                        "resolve",
                        requestId,
                        JSONObject().put("ok", false).put("error", "invalid_request"),
                    )
                    return
                }
                if (!activity.bridgePairingFeatureEnabled()) {
                    AgentMwaLog.warn(
                        "AndroidBridge",
                        "bridgeScanPairingQr",
                        "NOT_ENABLED",
                        "QR scanner bridge feature disabled",
                        mapOf("requestId" to requestId),
                    )
                    activity.dispatchQrScannerResult(
                        "resolve",
                        requestId,
                        JSONObject().put("ok", false).put("error", "not_enabled"),
                    )
                    return
                }
                AgentMwaLog.info(
                    "AndroidBridge",
                    "bridgeScanPairingQr",
                    "ACCEPT",
                    "QR scanner bridge request accepted",
                    mapOf("requestId" to requestId),
                )
                activity.startPairingQrScanner(requestId)
            } catch (err: Throwable) {
                AgentMwaLog.failure(
                    "AndroidBridge",
                    "bridgeScanPairingQr",
                    "SYNC_THROW",
                    "QR scanner bridge method threw before launch",
                    err,
                    mapOf("requestId" to requestId),
                )
                activity.dispatchQrScannerResult(
                    "resolve",
                    requestId,
                    JSONObject().put("ok", false).put("error", "native_exception"),
                )
            }
        }

        @JavascriptInterface
        fun bridgePairStatus(): String = safeBridge("bridgePairStatus", "{}") {
            if (!checkTrustedOrigin("bridgePairStatus")) return@safeBridge "{}"
            val status = activity.bridgePairStatusJson()
            AgentMwaLog.debug(
                "AndroidBridge",
                "bridgePairStatus",
                "DONE",
                "bridge pairing status read",
                mapOf(
                    "paired" to status.optBoolean("paired", false),
                    "pairing" to status.optBoolean("pairing", false),
                    "enabled" to status.optBoolean("enabled", false),
                    "hasError" to !status.isNull("error"),
                ),
            )
            status.toString()
        }

        /** {paired, desktopOnline}. desktopOnline is the LAST async probe (non-blocking); calling this
         *  also kicks off a fresh probe, so the JS chip converges within a couple of polls. */
        @JavascriptInterface
        fun bridgeRelayStatus(): String = safeBridge("bridgeRelayStatus", "{}") {
            if (!checkTrustedOrigin("bridgeRelayStatus")) return@safeBridge "{}"
            activity.bridgeRelayStatusJson().toString()
        }

        @JavascriptInterface
        fun bridgeUnpair(): String = safeBridge("bridgeUnpair", "{}") {
            if (!checkTrustedOrigin("bridgeUnpair")) return@safeBridge "{}"
            activity.clearBridgePairing().toString()
        }

        @JavascriptInterface
        fun deviceAgentStatus(): String = safeBridge("deviceAgentStatus", "{}") {
            if (!checkTrustedOrigin("deviceAgentStatus")) return@safeBridge "{}"
            activity.agentRuntimeController.statusJson().toString()
        }

        /**
         * Returns the full remote-config JSON the APK is currently using. JS callers
         * can read feature flags, wallet routing, or memo-proof envelope shape from
         * this without going through the network themselves (the APK already polled).
         */
        @JavascriptInterface
        fun remoteConfigGet(): String = safeBridge("remoteConfigGet", "{}") {
            if (!checkTrustedOrigin("remoteConfigGet")) return@safeBridge "{}"
            val snap = RemoteConfigLoader.current()
            JSONObject()
                .put("version", snap.config.version)
                .put("source", snap.source.id)
                .put("fetchedAtMs", snap.fetchedAtMs)
                .put("walletRegistry", JSONArray(snap.config.walletRegistry.map { entry ->
                    JSONObject()
                        .put("id", entry.id)
                        .put("name", entry.name)
                        .put("packageNames", JSONArray(entry.packageNames))
                        .put("uriPatterns", JSONArray(entry.uriPatterns))
                        .put("iconSha256First8", entry.iconSha256First8 ?: JSONObject.NULL)
                        .put("supportsSignMessages", entry.supportsSignMessages)
                        .put("supportsSiws", entry.supportsSiws)
                        .put("forceSignThenRpc", entry.forceSignThenRpc)
                }))
                .put("memoProofRouter", JSONObject()
                    .put("envelopeVersion", snap.config.memoProofRouter.envelopeVersion)
                    .put("proofMemoPrefix", snap.config.memoProofRouter.proofMemoPrefix)
                    .put("fallbackOnBlankPackage", snap.config.memoProofRouter.fallbackOnBlankPackage))
                .put("featureFlags", JSONObject(snap.config.featureFlags as Map<*, *>))
                .toString()
        }

        /**
         * Kick off a background refresh against `/api/android-config`. Returns the
         * current snapshot status immediately; JS callers should poll [remoteConfigStatus]
         * if they need to detect when the refresh actually lands.
         */
        @JavascriptInterface
        fun remoteConfigRefresh(): String = safeBridge("remoteConfigRefresh", "{}") {
            if (!checkTrustedOrigin("remoteConfigRefresh")) return@safeBridge "{}"
            RemoteConfigLoader.refresh(activity.lifecycleScope, force = true)
            RemoteConfigLoader.statusJson().toString()
        }

        /**
         * Lightweight snapshot status: version, source (server|cache|bundled),
         * fetchedAtMs, wallet count, envelope version. Cheap enough for JS to poll
         * after triggering a refresh.
         */
        @JavascriptInterface
        fun remoteConfigStatus(): String = safeBridge("remoteConfigStatus", "{}") {
            if (!checkTrustedOrigin("remoteConfigStatus")) return@safeBridge "{}"
            RemoteConfigLoader.statusJson().toString()
        }

        // ── Phase 2 system primitives ──────────────────────────────────────────
        // Added before APK submission so future web-bundle features don't require
        // a new APK + dApp Store review. See plan file
        // /Users/devlegacy/.claude/plans/getting-ready-to-ship-velvet-pine.md.

        /**
         * Open a URL via Intent.ACTION_VIEW (browser, mailto, tel, etc.). Returns
         * true on success, false if no app can handle the URL or dispatch threw.
         */
        @JavascriptInterface
        fun openExternal(url: String): Boolean = safeBridge("openExternal", false) {
            if (!checkTrustedOrigin("openExternal")) return@safeBridge false
            activity.systemBridge.openExternal(url)
        }

        /**
         * JSON: device/manufacturer/model/sdk/locale/timezone/battery/network.
         * No user-identifying data.
         */
        @JavascriptInterface
        fun systemInfo(): String = safeBridge("systemInfo", "{}") {
            if (!checkTrustedOrigin("systemInfo")) return@safeBridge "{}"
            activity.systemBridge.systemInfo().toString()
        }

        /** Copy text to the system clipboard. Returns true on success. */
        @JavascriptInterface
        fun clipboardWrite(text: String): Boolean = safeBridge("clipboardWrite", false) {
            if (!checkTrustedOrigin("clipboardWrite")) return@safeBridge false
            activity.systemBridge.clipboardWrite(text)
        }

        /**
         * Read the system clipboard text (empty string if none). Backs the WebView
         * "Paste key" button, since Android WebView blocks navigator.clipboard.readText().
         */
        @JavascriptInterface
        fun clipboardRead(): String = safeBridge("clipboardRead", "") {
            if (!checkTrustedOrigin("clipboardRead")) return@safeBridge ""
            activity.systemBridge.clipboardRead()
        }

        /** Haptic feedback: "light"|"medium"|"heavy". Returns true on success. */
        @JavascriptInterface
        fun haptic(pattern: String): Boolean = safeBridge("haptic", false) {
            if (!checkTrustedOrigin("haptic")) return@safeBridge false
            activity.systemBridge.haptic(pattern)
        }

        /**
         * Post a system notification. Payload JSON: { title, body, tag?, channelId? }.
         * Returns JSON envelope: { ok, id?, tag?, error? }.
         */
        @JavascriptInterface
        fun showNotification(payloadJson: String): String = safeBridge("showNotification", "{}") {
            if (!checkTrustedOrigin("showNotification")) return@safeBridge "{}"
            activity.systemBridge.showNotification(payloadJson).toString()
        }

        /**
         * Request the POST_NOTIFICATIONS runtime permission (Android 13+) and resolve the FCM token.
         * Async via __agenticAndroidPushBridge because the OS permission dialog is async. On <33 the
         * permission is implicit, so this goes straight to the token. THIS is the method whose absence
         * meant the notification card's toggles could never actually deliver on a modern device.
         */
        @JavascriptInterface
        fun requestNotificationPermission(requestId: String) = safeBridge("requestNotificationPermission", Unit) {
            if (!checkTrustedOrigin("requestNotificationPermission")) return@safeBridge Unit
            activity.runOnUiThread { activity.requestPushPermissionAndToken(requestId) }
        }

        /** Cold-launch notification tap route, drained by the SPA on init. "{}" when there is none. */
        @JavascriptInterface
        fun consumePushRoute(): String = safeBridge("consumePushRoute", "{}") {
            if (!checkTrustedOrigin("consumePushRoute")) return@safeBridge "{}"
            activity.consumePushRouteJson()
        }

        /** A token FCM rotated to while the app was closed and couldn't register (no session). "" if none. */
        @JavascriptInterface
        fun consumePendingPushToken(): String = safeBridge("consumePendingPushToken", "") {
            if (!checkTrustedOrigin("consumePendingPushToken")) return@safeBridge ""
            AgenticPushMessagingService.consumePendingToken(activity).orEmpty()
        }

        /**
         * Synchronous biometric capability check. Returns JSON: { status, kind }
         * where kind is one of AVAILABLE|NO_HARDWARE|HARDWARE_UNAVAILABLE|NO_ENROLLED|...
         */
        @JavascriptInterface
        fun biometricStatus(): String = safeBridge("biometricStatus", "{}") {
            if (!checkTrustedOrigin("biometricStatus")) return@safeBridge "{}"
            activity.biometricBridge.canAuthenticate().toString()
        }

        /**
         * Async biometric prompt. JS calls
         * `bridge.biometricPrompt(requestId, payloadJson)`, then awaits the result
         * via `window.__agenticAndroidBiometricBridge.resolve(requestId, envelope)`.
         * Payload schema:
         *   { title, subtitle?, description?, negativeButton?, allowDeviceCredential? }
         * Result envelope:
         *   { ok, kind, code?, message?, authType? }
         *
         * SECURITY: see [com.agentic.wallet.system.BiometricBridge] header — the result
         * envelope is JS-controllable. Use only as a UX gate, never as authorization
         * for releasing secrets or approving transactions.
         */
        @JavascriptInterface
        fun biometricPrompt(requestId: String, payloadJson: String) {
            if (!checkTrustedOrigin("biometricPrompt")) return
            if (!REQUEST_ID_PATTERN.matches(requestId)) {
                AgentMwaLog.warn(
                    "AndroidBridge",
                    "biometricPrompt",
                    "FAIL_INVALID_REQUEST_ID",
                    "biometric request rejected due to invalid id",
                    mapOf("requestId" to requestId),
                )
                return
            }
            activity.biometricBridge.prompt(payloadJson) { envelope ->
                activity.dispatchBiometricResult(requestId, envelope)
            }
        }

        /** App lifecycle subscription: returns the current state synchronously. */
        @JavascriptInterface
        fun appLifecycleState(): String = safeBridge("appLifecycleState", "{}") {
            if (!checkTrustedOrigin("appLifecycleState")) return@safeBridge "{}"
            JSONObject()
                .put("state", activity.currentLifecycleState())
                .put("hasFocus", activity.hasWindowFocus())
                .toString()
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
            val job = activity.lifecycleScope.launch {
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
            // Track the streaming job so 'cancelStream' can cancel it (→ disconnect).
            if (method == "completeStream") {
                activeStreamJob = job
                job.invokeOnCompletion { if (activeStreamJob === job) activeStreamJob = null }
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
                    val result = handleMwaRequest(requestId, method, payload)
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

        private suspend fun handleMwaRequest(requestId: String, method: String, payload: JSONObject): JSONObject {
            AgentMwaLog.info(
                "MainActivity",
                "handleMwaRequest",
                "START",
                "handling Android MWA bridge method",
                mapOf("method" to method, "requestId" to requestId, "payload" to if (BuildConfig.DEBUG) activity.mwaJsonLogSummary(payload) else "[debug-only]"),
            )
            return when (method) {
                "status" -> statusJson()
                "connect" -> {
                    val walletPackage = payload.optString("walletPackage", "")
                    val cluster = clusterFromPayload(payload)
                    val resolvedWalletPackage = MwaIdentityPreflight.resolveBackpackTargetPackage(activity.applicationContext, walletPackage)
                    MwaIdentityPreflight.logBeforeConnect(
                        context = activity.applicationContext,
                        identity = activity.defaultMwaIdentity(),
                        requestId = requestId,
                        cluster = cluster,
                        targetWalletPackage = walletPackage,
                        resolvedTargetWalletPackage = resolvedWalletPackage,
                    )
                    val record = activity.mwaController.connect(activity.activityResultSender, cluster, walletPackage)
                    statusJson(record)
                }
                "reconnectLatest" -> {
                    val record = activity.mwaController.reconnectLatest(clusterFromPayload(payload))
                    statusJson(record)
                }
                "reconnectSession" -> {
                    val sessionKey = payload.optString("authCacheKey", "")
                        .ifBlank { payload.optString("sessionKey", "") }
                        .ifBlank { throw MwaOperationException("INVALID_REQUEST", "reconnectSession requires authCacheKey") }
                    val record = activity.mwaController.reconnectSession(sessionKey, clusterFromPayload(payload))
                    statusJson(record)
                }
                "reconnectForPubkey" -> {
                    val pubkey = payload.optString("pubkey", "")
                        .ifBlank { payload.optString("publicKey", "") }
                        .ifBlank { payload.optString("address", "") }
                        .ifBlank { throw MwaOperationException("INVALID_REQUEST", "reconnectForPubkey requires pubkey") }
                    val walletPackage = payload.optString("walletPackage", "")
                    val walletType = payload.optInt("walletType", WalletRegistry.UNKNOWN)
                    val record = activity.mwaController.reconnectForPubkey(pubkey, clusterFromPayload(payload), walletPackage, walletType)
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
                    AgentMwaLog.info(
                        "MainActivity",
                        "getAuthToken",
                        "TOKEN_EXPORT",
                        "auth token exported through JS bridge",
                        mapOf(
                            "authLen" to token.length,
                            "publicKey" to record?.publicKeyBase58.orEmpty(),
                            "authCacheKey" to record?.let { activity.mwaController.authCacheKey(it) }.orEmpty(),
                            "walletPackage" to record?.walletPackage.orEmpty(),
                            "walletType" to (record?.walletType ?: WalletRegistry.UNKNOWN),
                            "cluster" to record?.cluster?.id.orEmpty(),
                            "hadRecord" to (record != null),
                        ),
                    )
                    JSONObject()
                        .put("authToken", token)
                        .put("authTokenLen", token.length)
                        .put("publicKey", record?.publicKeyBase58.orEmpty())
                        .put("authCacheKey", record?.let { activity.mwaController.authCacheKey(it) }.orEmpty())
                        .put("walletPackage", record?.walletPackage.orEmpty())
                        .put("walletType", record?.walletType ?: WalletRegistry.UNKNOWN)
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
                    AgentMwaLog.info(
                        "MainActivity",
                        "setAuthToken",
                        "TOKEN_IMPORT",
                        "auth token import received through JS bridge",
                        mapOf(
                            "authLen" to token.length,
                            "publicKey" to publicKey,
                            "walletPackage" to walletPackage,
                            "cluster" to cluster.id,
                        ),
                    )
                    val record = activity.mwaController.setAuthToken(token, publicKey, walletPackage, cluster)
                    AgentMwaLog.info(
                        "MainActivity",
                        "setAuthToken",
                        "TOKEN_IMPORT_RESULT",
                        "auth token import bridge result prepared",
                        mapOf(
                            "ok" to (record != null),
                            "authLen" to token.length,
                            "publicKey" to record?.publicKeyBase58.orEmpty(),
                            "authCacheKey" to record?.let { activity.mwaController.authCacheKey(it) }.orEmpty(),
                            "walletPackage" to record?.walletPackage.orEmpty(),
                            "walletType" to (record?.walletType ?: WalletRegistry.UNKNOWN),
                            "cluster" to record?.cluster?.id.orEmpty(),
                        ),
                    )
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
                // On-device chat-agent completion: a thin authenticated fetch. The JS loop
                // built the full provider body; native injects the stored key and POSTs it,
                // returning the raw { httpStatus, body } for JS to parse. Bypasses the
                // plan-policy runtime queue (it is a stateless read-and-relay).
                "complete" -> DeviceAgentOutcome(
                    activity.agentRuntimeController.statusJson(),
                    activity.agentRuntimeController.complete(payload),
                )
                // Streaming chat completion: native relays raw provider SSE chunks to JS
                // via the bridge's onChunk (marshaled to the UI thread for the WebView),
                // emits onStreamEnd, then resolves with {httpStatus, body?}. JS rebuilds a
                // Response from the chunks + reuses its SSE parser.
                "completeStream" -> {
                    val result = activity.agentRuntimeController.completeStream(payload) { chunk ->
                        activity.runOnUiThread { activity.pushDeviceAgentChatChunk(requestId, chunk) }
                    }
                    activity.runOnUiThread { activity.pushDeviceAgentChatStreamEnd(requestId) }
                    DeviceAgentOutcome(activity.agentRuntimeController.statusJson(), result)
                }
                // Cancel the in-flight streaming coroutine (JS Stop mid-stream). The
                // cancellation disconnects the streaming HttpURLConnection. Best-effort.
                "cancelStream" -> {
                    activeStreamJob?.cancel()
                    activeStreamJob = null
                    DeviceAgentOutcome(activity.agentRuntimeController.statusJson(), JSONObject().put("cancelled", true))
                }
                "generatePlan", "reviewPlan", "ask", "localize", "chat" -> {
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
                    .put("authCacheKey", activity.mwaController.authCacheKey(record))
                    .put("sessionKey", activity.mwaController.authCacheKey(record))
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
            AgentCluster.requireSupported(payload.optString("cluster", "mainnet-beta"))

        private fun bridgeRequestFromPayload(payload: JSONObject): AgentMwaBridgeRequest {
            val signingPayload = payload.optJSONObject("payload") ?: JSONObject()
            val display = payload.optJSONObject("display")
            val request = AgentMwaBridgeRequest(
                id = payload.optString("id", ""),
                kind = payload.optString("kind", ""),
                payloadData = signingPayload.optString("data", ""),
                payloadEncoding = signingPayload.optString("encoding", "base64"),
                cluster = AgentCluster.requireSupported(payload.optString("cluster", "mainnet-beta")),
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
                "reconnectSession",
                "reconnectForPubkey",
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
                "localize",
                // On-device chat-agent completion: one keyed model call per loop turn.
                "complete",
                // Streaming variant: native relays provider SSE chunks to JS.
                "completeStream",
                // Cancel the in-flight streaming request (JS Stop mid-stream).
                "cancelStream",
                // Paired Plan-Connector chat: forwarded to the desktop connector via
                // BridgeRelayProvider (the runtime executor.chat handler).
                "chat",
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
        private const val CAMERA_PERMISSION_REQUEST_CODE = 0x0CA3
        private const val NOTIFICATION_PERMISSION_REQUEST_CODE = 0x0107
        private const val LOCAL_APP_HOST = "agentic.local"
        private const val LOCAL_APP_START_URL = "https://agentic.local/"
        // Minimum gap before a foregrounded app retries the live URL after a
        // bundled fallback (avoids hammering a flaky remote on rapid resumes).
        private const val REMOTE_RETRY_COOLDOWN_MS = 60_000L
        // Min gap between render-process-gone recoveries. Process-static (companion) so it survives
        // the recreate() the recovery performs, letting us detect a tight renderer-death loop and
        // stop auto-recovering instead of looping recreate→crash→recreate.
        private const val RENDER_RECOVERY_MIN_INTERVAL_MS = 5_000L
        @Volatile private var lastRenderRecoveryAt = 0L

        private fun sha256First8(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256")
                .digest(bytes)
                .take(8)
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }

        private fun bridgePairTag(uuid: String): String =
            if (uuid.isBlank()) "" else MessageDigest.getInstance("SHA-256")
                .digest(uuid.toByteArray(Charsets.UTF_8))
                .take(4)
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }

        private fun relayHostForLog(relay: String): String =
            Uri.parse(relay).host?.lowercase().orEmpty()
    }
}

internal fun shouldRestoreSavedWebViewState(remoteWebUrl: String, savedInstanceStatePresent: Boolean): Boolean =
    remoteWebUrl.isBlank() && savedInstanceStatePresent

internal fun shouldReloadRemoteFromWebViewUrl(
    remoteWebUrl: String,
    remoteWebHost: String?,
    currentUrl: String,
): Boolean {
    if (remoteWebUrl.isBlank()) return false
    val host = runCatching { java.net.URI(currentUrl).host?.lowercase() }.getOrNull() ?: return true
    return host == "agentic.local" || (remoteWebHost != null && host != remoteWebHost)
}
