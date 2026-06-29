package com.agentic.wallet

import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.content.Context
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.agentic.wallet.mwa.AgentCluster
import com.agentic.wallet.mwa.AgentWalletBalanceSummary
import com.agentic.wallet.mwa.AgentMwaBridgeRequest
import com.agentic.wallet.mwa.AgentMwaIdentity
import com.agentic.wallet.mwa.AgentMwaLog
import com.agentic.wallet.mwa.BridgeClient
import com.agentic.wallet.mwa.MwaController
import com.agentic.wallet.mwa.MwaOperationException
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MwaExampleActivity : ComponentActivity() {
    private lateinit var controller: MwaController
    private lateinit var activityResultSender: ActivityResultSender
    private lateinit var statusView: TextView
    private lateinit var logView: TextView
    private lateinit var clusterSpinner: Spinner
    private lateinit var siwsDomainInput: EditText
    private lateinit var siwsStatementInput: EditText
    private lateinit var messageInput: EditText
    private lateinit var transactionInput: EditText
    private lateinit var bridgeUrlInput: EditText
    private lateinit var bridgeTokenInput: EditText
    private var walletBalanceView: TextView? = null
    private var bridgeSummaryView: TextView? = null
    private var requestSummaryView: TextView? = null
    private var walletBalanceSummary: AgentWalletBalanceSummary? = null
    private var walletBalanceLoading = false
    private var walletBalanceStatus = "Connect a wallet to load balances."
    private val actionButtons = mutableListOf<Button>()
    private var bridgeClient: BridgeClient? = null
    private var bridgeJob: Job? = null
    private var showingExampleApp = false
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // CRITICAL: ActivityResultSender must be constructed BEFORE the activity reaches STARTED.
        activityResultSender = ActivityResultSender(this)
        showingExampleApp = true
        val mode = "example_native"
        AgentMwaLog.info(
            "MwaExampleActivity",
            "onCreate",
            "START",
            "MWA example activity launched",
            mapOf(
                "mode" to mode,
                "webFallbackEnabled" to BuildConfig.AGENTIC_ANDROID_ENABLE_WEB_FALLBACK,
            ),
        )
        controller = MwaController(applicationContext, defaultIdentity())
        setContentView(buildExampleContent())
        appendLog("Native mode: $mode. Web fallback: ${if (BuildConfig.AGENTIC_ANDROID_ENABLE_WEB_FALLBACK) "enabled" else "disabled"}.")
        val restored = controller.reconnectLatest()
        if (restored != null) {
            setCluster(restored.cluster)
            appendLog("Restored cached authorization for ${short(restored.publicKeyBase58)}.")
        } else {
            appendLog("No cached Android MWA authorization found.")
        }
        renderState()
    }

    override fun onDestroy() {
        bridgeJob?.cancel()
        bridgeJob = null
        super.onDestroy()
    }

    private fun buildAppContent(): View {
        actionButtons.clear()
        bridgeSummaryView = null
        requestSummaryView = null
        walletBalanceView = null
        val scrollView = ScrollView(this).apply {
            setBackgroundColor(Color.rgb(5, 7, 6))
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(22), dp(18), dp(28))
        }
        scrollView.addView(root)

        root.addView(TextView(this).apply {
            text = "Agentic"
            textSize = 30f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
        })
        root.addView(TextView(this).apply {
            text = "Your wallet stays the signer."
            textSize = 15f
            setTextColor(Color.rgb(171, 184, 178))
            setPadding(0, dp(2), 0, dp(18))
        })

        val overview = panel()
        overview.addView(cardTitle("Signer"))
        overview.addView(bodyText("Connect a Solana wallet on this device. Agentic can prepare requests, but your wallet reviews and signs."))
        statusView = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.rgb(224, 232, 228))
            setPadding(0, dp(12), 0, dp(12))
        }
        overview.addView(statusView)
        walletBalanceView = bodyText(walletBalanceText())
        overview.addView(walletBalanceView)

        clusterSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MwaExampleActivity,
                android.R.layout.simple_spinner_dropdown_item,
                AgentCluster.entries.map { it.id },
            )
        }
        overview.addView(label("Cluster"))
        overview.addView(clusterSpinner)
        row(
            overview,
            button("Connect wallet", primary = true) { connectWallet() },
            button("Reconnect") { reconnectCached() },
        )
        overview.addView(button("Refresh balances") { refreshWalletBalanceAction() })
        root.addView(overview)

        val requests = panel()
        requests.addView(cardTitle("Agent requests"))
        requestSummaryView = bodyText("No pending request. Connect the Agentic bridge below to listen for approvals from desktop, CLI, or MCP agents.")
        requests.addView(requestSummaryView)
        root.addView(requests)

        val bridge = panel()
        bridge.addView(cardTitle("Agent connection"))
        bridgeSummaryView = bodyText("Bridge is offline. Start listening when your local Agentic bridge is running.")
        bridge.addView(bridgeSummaryView)
        bridgeUrlInput = EditText(this).apply {
            hint = "Bridge URL"
            setText("http://127.0.0.1:8787")
            setSingleLine(true)
        }
        bridge.addView(label("Bridge URL"))
        bridge.addView(bridgeUrlInput)
        bridgeTokenInput = EditText(this).apply {
            hint = "Bridge token"
            setText("local-agent-wallet")
            setSingleLine(true)
        }
        bridge.addView(label("Bridge token"))
        bridge.addView(bridgeTokenInput)
        row(
            bridge,
            button("Start listening", primary = true) { connectBridge() },
            button("Stop") { disconnectBridge() },
        )
        root.addView(bridge)

        val advanced = panel()
        advanced.addView(cardTitle("Advanced wallet tools"))
        advanced.addView(bodyText("Manual signing and reset controls for debugging wallet integrations."))
        advanced.addView(button("Get capabilities") { getCapabilities() })
        siwsDomainInput = EditText(this).apply {
            hint = "SIWS domain"
            setText(Uri.parse(BuildConfig.AGENTIC_LAUNCH_URL).host ?: "agenticwalletadapter.com")
            setSingleLine(true)
        }
        advanced.addView(label("SIWS domain"))
        advanced.addView(siwsDomainInput)
        siwsStatementInput = EditText(this).apply {
            hint = "SIWS statement"
            setText("Sign in to Agentic.")
            minLines = 2
        }
        advanced.addView(label("SIWS statement"))
        advanced.addView(siwsStatementInput)
        advanced.addView(button("Connect + SIWS") { connectWithSignIn() })
        messageInput = EditText(this).apply {
            hint = "Message to sign"
            setText("Approve this Solana agent action with user custody.")
            minLines = 2
        }
        advanced.addView(label("Manual message"))
        advanced.addView(messageInput)
        advanced.addView(button("Sign message") { signMessage() })
        transactionInput = EditText(this).apply {
            hint = "Base64 serialized transaction"
            minLines = 3
        }
        advanced.addView(label("Serialized transaction"))
        advanced.addView(transactionInput)
        row(
            advanced,
            button("Sign transaction") { signTransaction() },
            button("Sign and send") { signAndSendTransaction() },
        )
        row(
            advanced,
            button("Disconnect wallet") { disconnectWallet() },
            button("Clear session") { clearTransient() },
        )
        row(
            advanced,
            button("Full reset") { clearFullReset() },
            button("Clear accounts") { clearAllAccounts() },
        )
        if (BuildConfig.AGENTIC_ANDROID_ENABLE_WEB_FALLBACK) {
            advanced.addView(button("Open web fallback") { openWebFallback() })
        }
        root.addView(advanced)

        val logPanel = panel()
        logPanel.addView(cardTitle("Activity"))
        logView = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.rgb(190, 202, 196))
        }
        logPanel.addView(logView)
        root.addView(logPanel)

        return scrollView
    }

    private fun buildExampleContent(): View {
        actionButtons.clear()
        walletBalanceView = null
        val scrollView = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(24))
        }
        scrollView.addView(root)

        root.addView(TextView(this).apply {
            text = "Agentic Android MWA"
            textSize = 24f
            setPadding(0, 0, 0, dp(8))
        })
        statusView = TextView(this).apply {
            textSize = 14f
            setPadding(0, 0, 0, dp(12))
        }
        root.addView(statusView)
        walletBalanceView = TextView(this).apply {
            textSize = 14f
            setPadding(0, 0, 0, dp(12))
        }
        root.addView(walletBalanceView)

        clusterSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MwaExampleActivity,
                android.R.layout.simple_spinner_dropdown_item,
                AgentCluster.entries.map { it.id },
            )
        }
        root.addView(label("Cluster"))
        root.addView(clusterSpinner)

        row(root,
            button("Connect wallet") { connectWallet() },
            button("Reconnect cached") { reconnectCached() },
        )
        root.addView(button("Refresh balances") { refreshWalletBalanceAction() })
        row(root,
            button("Disconnect") { disconnectWallet() },
            button("Clear transient") { clearTransient() },
        )
        row(root,
            button("Full reset") { clearFullReset() },
            button("Clear all accounts") { clearAllAccounts() },
        )

        root.addView(section("Wallet Methods"))
        root.addView(button("Get capabilities") { getCapabilities() })
        siwsDomainInput = EditText(this).apply {
            hint = "SIWS domain"
            setText(Uri.parse(BuildConfig.AGENTIC_LAUNCH_URL).host ?: "agenticwalletadapter.com")
            setSingleLine(true)
        }
        root.addView(siwsDomainInput)
        siwsStatementInput = EditText(this).apply {
            hint = "SIWS statement"
            setText("Sign in to Agentic Android MWA.")
            minLines = 2
        }
        root.addView(siwsStatementInput)
        root.addView(button("Connect + SIWS") { connectWithSignIn() })
        messageInput = EditText(this).apply {
            hint = "Message to sign"
            setText("Approve this Solana agent action with user custody.")
            minLines = 2
        }
        root.addView(messageInput)
        root.addView(button("Sign message") { signMessage() })

        transactionInput = EditText(this).apply {
            hint = "Base64 serialized transaction"
            minLines = 3
        }
        root.addView(transactionInput)
        row(root,
            button("Sign transaction") { signTransaction() },
            button("Sign and send") { signAndSendTransaction() },
        )

        root.addView(section("Local Bridge"))
        bridgeUrlInput = EditText(this).apply {
            hint = "Bridge URL"
            setText("http://127.0.0.1:8787")
            setSingleLine(true)
        }
        root.addView(bridgeUrlInput)
        bridgeTokenInput = EditText(this).apply {
            hint = "Bridge token"
            setText("local-agent-wallet")
            setSingleLine(true)
        }
        root.addView(bridgeTokenInput)
        row(root,
            button("Connect bridge") { connectBridge() },
            button("Disconnect bridge") { disconnectBridge() },
        )

        if (BuildConfig.AGENTIC_ANDROID_ENABLE_WEB_FALLBACK) {
            root.addView(section("Fallback"))
            root.addView(button("Open web app") { openWebFallback() })
        }

        root.addView(section("Log"))
        logView = TextView(this).apply {
            textSize = 12f
            setPadding(0, dp(6), 0, 0)
        }
        root.addView(logView)
        return scrollView
    }

    private fun openWebFallback() {
        if (!BuildConfig.AGENTIC_ANDROID_ENABLE_WEB_FALLBACK) {
            appendLog("Web fallback is disabled for this build.")
            return
        }
        startActivity(Intent(this, WebLaunchActivity::class.java).setData(Uri.parse(BuildConfig.AGENTIC_LAUNCH_URL)))
    }

    private fun connectWallet() = runAction("connect") {
        val record = controller.connect(activityResultSender, selectedCluster())
        appendLog("Connected ${short(record.publicKeyBase58)} on ${record.cluster.id}.")
        refreshWalletBalance(record)
        renderState()
    }

    private fun reconnectCached() = runAction("reconnect") {
        val record = controller.reconnectLatest(selectedCluster())
            ?: throw MwaOperationException("UNAUTHORIZED", "No cached authorization is available. Connect first.")
        appendLog("Reconnected cached ${short(record.publicKeyBase58)}.")
        refreshWalletBalance(record)
        renderState()
    }

    private fun disconnectWallet() = runAction("disconnect") {
        disconnectBridgeInternal()
        controller.disconnect()
        clearWalletBalance()
        appendLog("Wallet disconnected. Cached authorization marked inactive.")
        renderState()
    }

    private fun clearTransient() = runAction("clearTransient") {
        disconnectBridgeInternal()
        controller.clearTransientState("android_ui")
        clearWalletBalance()
        appendLog("Transient state cleared. Auth cache retained.")
        renderState()
    }

    private fun clearFullReset() = runAction("clearFullReset") {
        disconnectBridgeInternal()
        controller.deauthorizeRemote(activityResultSender, "android_ui")
        clearWalletBalance()
        appendLog("Full local wallet reset complete.")
        renderState()
    }

    private fun clearAllAccounts() = runAction("clearAllAccounts") {
        disconnectBridgeInternal()
        controller.clearAllCachedAuthorizations()
        clearWalletBalance()
        appendLog("All cached accounts cleared.")
        renderState()
    }

    private fun refreshWalletBalanceAction() = runAction("refreshWalletBalance") {
        val record = controller.activeAuthorization()
            ?: controller.reconnectLatest(selectedCluster())
            ?: throw MwaOperationException("UNAUTHORIZED", "Connect or reconnect a wallet before loading balances.")
        refreshWalletBalance(record)
    }

    private suspend fun refreshWalletBalance(record: com.agentic.wallet.mwa.AgentMwaAuthRecord) {
        walletBalanceLoading = true
        walletBalanceStatus = "Loading balances"
        renderState()
        try {
            walletBalanceSummary = controller.connectedWalletBalanceSummary(record)
            walletBalanceStatus = walletBalanceSummary?.statusText ?: "Balances loaded."
        } catch (err: Exception) {
            walletBalanceSummary = null
            walletBalanceStatus = "Balances unavailable"
            appendLog("Balance summary unavailable: ${err.message ?: err.javaClass.simpleName}")
        } finally {
            walletBalanceLoading = false
            renderState()
        }
    }

    private fun clearWalletBalance() {
        walletBalanceSummary = null
        walletBalanceLoading = false
        walletBalanceStatus = "Connect a wallet to load balances."
    }

    private fun getCapabilities() = runAction("getCapabilities") {
        val caps = controller.getCapabilities(activityResultSender)
        appendLog("Capabilities: $caps")
        renderState()
    }

    private fun connectWithSignIn() = runAction("connectWithSignIn") {
        hideKeyboard()
        val result = controller.connectWithSignIn(
            activityResultSender,
            selectedCluster(),
            siwsDomainInput.text.toString().trim(),
            siwsStatementInput.text.toString().trim(),
        )
        appendLog("SIWS (${result.path}) sig=${short(result.signature)} pubkey=${short(result.publicKeyBase58)} label=${result.accountLabel.ifBlank { "(none)" }} chains=[${result.chains.joinToString(",")}] features=[${result.features.joinToString(",")}]")
        renderState()
    }

    private fun signMessage() = runAction("signMessage") {
        hideKeyboard()
        val result = controller.signMessage(activityResultSender, messageInput.text.toString())
        appendLog("Message signature: ${short(result.signature)}")
    }

    private fun signTransaction() = runAction("signTransaction") {
        hideKeyboard()
        val tx = decodeTransactionInput()
        val result = controller.signTransaction(activityResultSender, tx)
        appendLog("Signed transaction bytes, base64 length ${result.signature.length}.")
    }

    private fun signAndSendTransaction() = runAction("signAndSend") {
        hideKeyboard()
        val tx = decodeTransactionInput()
        val result = controller.signAndSendTransaction(activityResultSender, tx)
        appendLog("Transaction sent: ${short(result.txid ?: result.signature)}")
    }

    private fun connectBridge() = runAction("connectBridge") {
        hideKeyboard()
        AgentMwaLog.info(
            "MwaExampleActivity",
            "connectBridge",
            "STEP_INPUT",
            "bridge connect inputs captured",
            mapOf("bridgeUrl" to bridgeUrlInput.text.toString().trim(), "bridgeAuthHeaderChars" to bridgeTokenInput.text.toString().trim().length),
        )
        val active = controller.activeAuthorization()
            ?: controller.reconnectLatest(selectedCluster())
            ?: throw MwaOperationException("UNAUTHORIZED", "Connect or reconnect a wallet before connecting the bridge.")
        val client = BridgeClient(bridgeUrlInput.text.toString().trim(), bridgeTokenInput.text.toString().trim())
        val (bridgeCluster, _) = client.config()
        if (bridgeCluster != active.cluster) {
            setCluster(bridgeCluster)
            val adjusted = controller.reconnectLatest(bridgeCluster)
                ?: throw MwaOperationException("CLUSTER_MISMATCH", "Bridge is ${bridgeCluster.id}, but no cached wallet was available for reconnect.")
            appendLog("Adjusted wallet cluster to bridge config ${adjusted.cluster.id}.")
        }
        client.connect(controller.activeAuthorization()!!.publicKeyBase58, controller.capabilitiesJson())
        bridgeClient = client
        startBridgePolling()
        appendLog("Bridge connected. Polling for agent signing requests.")
        renderState()
    }

    private fun disconnectBridge() = runAction("disconnectBridge") {
        disconnectBridgeInternal()
        appendLog("Bridge disconnected.")
        renderState()
    }

    private suspend fun disconnectBridgeInternal() {
        bridgeJob?.cancel()
        bridgeJob = null
        bridgeClient?.disconnect()
        bridgeClient = null
    }

    private fun startBridgePolling() {
        bridgeJob?.cancel()
        val client = bridgeClient ?: return
        bridgeJob = lifecycleScope.launch {
            while (isActive) {
                try {
                    val request = client.nextRequest()
                    if (request != null) {
                        handleBridgeRequest(client, request)
                    }
                } catch (err: Exception) {
                    appendLog("Bridge poll failed: ${err.message ?: err.javaClass.simpleName}")
                }
                delay(1_000)
            }
        }
    }

    private suspend fun handleBridgeRequest(client: BridgeClient, request: AgentMwaBridgeRequest) {
        appendLog("Bridge request ${request.kind}: ${request.summary ?: request.id}")
        requestSummaryView?.text = "Reviewing ${request.kind}: ${request.summary ?: request.id}"
        AgentMwaLog.info(
            "MainActivity",
            "handleBridgeRequest",
            "START",
            "bridge request claimed",
            mapOf("requestId" to request.id, "kind" to request.kind, "cluster" to request.cluster.id),
        )
        try {
            val result = controller.signBridgeRequest(activityResultSender, request)
            client.resolve(request.id, result)
            appendLog("Approved ${request.kind}: ${short(result.txid ?: result.signature)}")
            requestSummaryView?.text = "Approved ${request.kind}. Waiting for the next agent request."
        } catch (err: MwaOperationException) {
            client.reject(request.id, err)
            appendLog("Rejected ${request.kind}: ${err.code} ${err.message}")
            requestSummaryView?.text = "Rejected ${request.kind}. Waiting for the next agent request."
            AgentMwaLog.failure(
                "MwaExampleActivity",
                "handleBridgeRequest",
                "FAIL_MWA_OPERATION",
                "bridge request handling failed with MWA error",
                err,
                mapOf("requestId" to request.id, "kind" to request.kind, "code" to err.code),
            )
        } catch (err: Exception) {
            val wrapped = MwaOperationException("WALLET_ERROR", err.message ?: err.javaClass.simpleName, err)
            client.reject(request.id, wrapped)
            appendLog("Failed ${request.kind}: ${wrapped.message}")
            requestSummaryView?.text = "Request failed. Waiting for the next agent request."
            AgentMwaLog.failure(
                "MwaExampleActivity",
                "handleBridgeRequest",
                "FAIL_EXCEPTION",
                "bridge request handling threw",
                err,
                mapOf("requestId" to request.id, "kind" to request.kind),
            )
        }
    }

    private fun runAction(label: String, block: suspend () -> Unit) {
        if (busy) return
        lifecycleScope.launch {
            busy = true
            renderState()
            try {
                AgentMwaLog.info("MainActivity", label, "START", "user action started")
                block()
                AgentMwaLog.info("MainActivity", label, "SUCCESS", "user action completed")
            } catch (err: MwaOperationException) {
                appendLog("${err.code}: ${err.message}")
                AgentMwaLog.failure("MainActivity", label, "FAIL", "user action failed", err, mapOf("code" to err.code))
            } catch (err: Exception) {
                appendLog("ERROR: ${err.message ?: err.javaClass.simpleName}")
                AgentMwaLog.failure("MainActivity", label, "FAIL", "user action failed", err)
            } finally {
                busy = false
                renderState()
            }
        }
    }

    private fun renderState() {
        val active = controller.activeAuthorization()
        val cached = controller.cachedAuthorizations()
        statusView.text =
            if (showingExampleApp) {
                buildString {
                    appendLine("Wallet: ${active?.publicKeyBase58?.let { short(it) } ?: "not connected"}")
                    appendLine("Cluster: ${active?.cluster?.id ?: selectedCluster().id}")
                    appendLine("Wallet package: ${active?.walletPackage?.ifBlank { "(unknown)" } ?: "(none)"}")
                    appendLine("Cached accounts: ${cached.size}${if (cached.isNotEmpty()) " (latest ${short(cached.maxBy { it.timestampUnixSeconds }.publicKeyBase58)})" else ""}")
                    appendLine("Bridge: ${if (bridgeClient != null) "connected" else "offline"}")
                }
            } else {
                buildString {
                    if (active == null) {
                        appendLine("No wallet connected")
                        appendLine("Choose ${selectedCluster().id} and connect a signer to begin.")
                    } else {
                        appendLine("Wallet connected: ${short(active.publicKeyBase58)}")
                        appendLine("Cluster: ${active.cluster.id}")
                    }
                    appendLine("Cached signers: ${cached.size}")
                }
            }
        bridgeSummaryView?.text = if (bridgeClient != null) {
            "Bridge is connected and polling for agent approvals."
        } else {
            "Bridge is offline. Start listening when your local Agentic bridge is running."
        }
        walletBalanceView?.text = walletBalanceText()
        if (bridgeClient == null) {
            requestSummaryView?.text = "No pending request. Connect the Agentic bridge below to listen for approvals from desktop, CLI, or MCP agents."
        } else if (requestSummaryView?.text.isNullOrBlank() || requestSummaryView?.text?.startsWith("No pending request") == true) {
            requestSummaryView?.text = "Listening for agent requests. Your wallet will still review every signature."
        }
        actionButtons.forEach { it.isEnabled = !busy }
        clusterSpinner.isEnabled = !busy && bridgeClient == null
    }

    private fun walletBalanceText(): String {
        val summary = walletBalanceSummary
        return when {
            walletBalanceLoading -> "Balances: loading..."
            summary != null -> "Wallet value: ${summary.totalText}\nSOL: ${summary.solText}\nUSDC: ${summary.usdcText}\n${summary.statusText}"
            else -> "Balances: $walletBalanceStatus"
        }
    }

    private fun selectedCluster(): AgentCluster =
        AgentCluster.fromId(clusterSpinner.selectedItem?.toString())

    private fun setCluster(cluster: AgentCluster) {
        val index = AgentCluster.entries.indexOf(cluster).coerceAtLeast(0)
        clusterSpinner.setSelection(index)
    }

    private fun defaultIdentity(): AgentMwaIdentity {
        val launch = Uri.parse(BuildConfig.AGENTIC_LAUNCH_URL)
        val origin = "${launch.scheme}://${launch.host}${if (launch.port > 0) ":${launch.port}" else ""}"
        return AgentMwaIdentity(
            name = "Agentic",
            uri = origin,
            // MWA spec: iconRelativeUri must be relative to identityUri.
            iconUri = "favicon.ico",
        )
    }

    private fun decodeTransactionInput(): ByteArray {
        val value = transactionInput.text.toString().trim()
        AgentMwaLog.info(
            "MwaExampleActivity",
            "decodeTransactionInput",
            "START",
            "decoding manual transaction input",
            mapOf("base64Chars" to value.length, "base64Payload" to if (BuildConfig.DEBUG) value else "[debug-only]"),
        )
        if (value.isBlank()) {
            throw MwaOperationException("INVALID_PAYLOADS", "Paste a base64 serialized transaction first.")
        }
        return try {
            Base64.decode(value, Base64.DEFAULT).also {
                AgentMwaLog.info(
                    "MwaExampleActivity",
                    "decodeTransactionInput",
                    "SUCCESS",
                    "manual transaction input decoded",
                    AgentMwaLog.transactionMetadata("transaction", it),
                )
            }
        } catch (err: IllegalArgumentException) {
            AgentMwaLog.failure(
                "MwaExampleActivity",
                "decodeTransactionInput",
                "FAIL_DECODE",
                "manual transaction input decode failed",
                err,
                mapOf("base64Chars" to value.length, "base64Payload" to if (BuildConfig.DEBUG) value else "[debug-only]"),
            )
            throw MwaOperationException("INVALID_PAYLOADS", "Invalid base64 serialized transaction: ${err.message}", err)
        }
    }

    private fun appendLog(line: String) {
        if (!::logView.isInitialized) return
        val prefix = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        logView.text = ("$prefix  $line\n${logView.text}").take(8_000)
    }

    private fun panel(): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(8).toFloat()
                setColor(Color.rgb(9, 14, 12))
                setStroke(dp(1), Color.rgb(31, 50, 41))
            }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                setMargins(0, 0, 0, dp(12))
            }
        }

    private fun cardTitle(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            setPadding(0, 0, 0, dp(8))
        }

    private fun bodyText(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 14f
            setTextColor(Color.rgb(188, 202, 195))
            setPadding(0, 0, 0, dp(10))
        }

    private fun label(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 12f
            setTextColor(Color.rgb(157, 172, 165))
            setPadding(0, dp(8), 0, dp(3))
        }

    private fun section(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 18f
            setTextColor(Color.rgb(224, 232, 228))
            setPadding(0, dp(18), 0, dp(8))
        }

    private fun button(text: String, primary: Boolean = false, onClick: () -> Unit): Button =
        Button(this).apply {
            this.text = text
            isAllCaps = false
            setTextColor(if (primary) Color.rgb(3, 14, 9) else Color.WHITE)
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(7).toFloat()
                setColor(if (primary) Color.rgb(125, 231, 176) else Color.rgb(47, 55, 52))
                if (!primary) setStroke(dp(1), Color.rgb(73, 88, 81))
            }
            minHeight = dp(44)
            setOnClickListener { onClick() }
            actionButtons.add(this)
        }

    private fun row(root: LinearLayout, vararg views: View) {
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            views.forEach { view ->
                addView(view, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                    setMargins(dp(2), dp(2), dp(2), dp(2))
                })
            }
        })
    }

    private fun hideKeyboard() {
        val manager = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        manager.hideSoftInputFromWindow(window.decorView.windowToken, 0)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun short(value: String, head: Int = 8, tail: Int = 8): String =
        if (value.length <= head + tail + 3) value else "${value.take(head)}...${value.takeLast(tail)}"
}
