package com.agentic.wallet

import android.content.Intent
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
import com.agentic.wallet.mwa.AgentMwaBridgeRequest
import com.agentic.wallet.mwa.AgentMwaIdentity
import com.agentic.wallet.mwa.AgentMwaLog
import com.agentic.wallet.mwa.BridgeClient
import com.agentic.wallet.mwa.MwaController
import com.agentic.wallet.mwa.MwaOperationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
    private lateinit var controller: MwaController
    private lateinit var statusView: TextView
    private lateinit var logView: TextView
    private lateinit var clusterSpinner: Spinner
    private lateinit var siwsDomainInput: EditText
    private lateinit var siwsStatementInput: EditText
    private lateinit var messageInput: EditText
    private lateinit var transactionInput: EditText
    private lateinit var bridgeUrlInput: EditText
    private lateinit var bridgeTokenInput: EditText
    private val actionButtons = mutableListOf<Button>()
    private var bridgeClient: BridgeClient? = null
    private var bridgeJob: Job? = null
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!BuildConfig.AGENTIC_ANDROID_SHOW_EXAMPLE_APP) {
            startActivity(Intent(this, WebLaunchActivity::class.java).setData(Uri.parse(BuildConfig.AGENTIC_LAUNCH_URL)))
            finish()
            return
        }

        controller = MwaController(applicationContext, defaultIdentity())
        setContentView(buildContent())
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

    private fun buildContent(): View {
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

        clusterSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
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

        root.addView(section("Fallback"))
        root.addView(button("Open web app") {
            startActivity(Intent(this, WebLaunchActivity::class.java).setData(Uri.parse(BuildConfig.AGENTIC_LAUNCH_URL)))
        })

        root.addView(section("Log"))
        logView = TextView(this).apply {
            textSize = 12f
            setPadding(0, dp(6), 0, 0)
        }
        root.addView(logView)
        return scrollView
    }

    private fun connectWallet() = runAction("connect") {
        val record = controller.connect(this, selectedCluster())
        appendLog("Connected ${short(record.publicKeyBase58)} on ${record.cluster.id}.")
        renderState()
    }

    private fun reconnectCached() = runAction("reconnect") {
        val record = controller.reconnectLatest(selectedCluster())
            ?: throw MwaOperationException("UNAUTHORIZED", "No cached authorization is available. Connect first.")
        appendLog("Reconnected cached ${short(record.publicKeyBase58)}.")
        renderState()
    }

    private fun disconnectWallet() = runAction("disconnect") {
        disconnectBridgeInternal()
        controller.disconnect()
        appendLog("Wallet disconnected. Auth cache retained.")
        renderState()
    }

    private fun clearTransient() = runAction("clearTransient") {
        disconnectBridgeInternal()
        controller.clearTransientState("android_ui")
        appendLog("Transient state cleared. Auth cache retained.")
        renderState()
    }

    private fun clearFullReset() = runAction("clearFullReset") {
        disconnectBridgeInternal()
        controller.deauthorizeRemote(this, "android_ui")
        appendLog("Full local wallet reset complete.")
        renderState()
    }

    private fun clearAllAccounts() = runAction("clearAllAccounts") {
        disconnectBridgeInternal()
        controller.clearAllCachedAuthorizations()
        appendLog("All cached accounts cleared.")
        renderState()
    }

    private fun getCapabilities() = runAction("getCapabilities") {
        val caps = controller.getCapabilities(this)
        appendLog("Capabilities: $caps")
        renderState()
    }

    private fun connectWithSignIn() = runAction("connectWithSignIn") {
        hideKeyboard()
        val result = controller.connectWithSignIn(
            this,
            selectedCluster(),
            siwsDomainInput.text.toString().trim(),
            siwsStatementInput.text.toString().trim(),
        )
        appendLog("SIWS signature: ${short(result.signature)}")
        renderState()
    }

    private fun signMessage() = runAction("signMessage") {
        hideKeyboard()
        val result = controller.signMessage(this, messageInput.text.toString())
        appendLog("Message signature: ${short(result.signature)}")
    }

    private fun signTransaction() = runAction("signTransaction") {
        hideKeyboard()
        val tx = decodeTransactionInput()
        val result = controller.signTransaction(this, tx)
        appendLog("Signed transaction bytes, base64 length ${result.signature.length}.")
    }

    private fun signAndSendTransaction() = runAction("signAndSend") {
        hideKeyboard()
        val tx = decodeTransactionInput()
        val result = controller.signAndSendTransaction(this, tx)
        appendLog("Transaction sent: ${short(result.txid ?: result.signature)}")
    }

    private fun connectBridge() = runAction("connectBridge") {
        hideKeyboard()
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
        AgentMwaLog.info(
            "MainActivity",
            "handleBridgeRequest",
            "START",
            "bridge request claimed",
            mapOf("requestId" to request.id, "kind" to request.kind, "cluster" to request.cluster.id),
        )
        try {
            val result = controller.signBridgeRequest(this, request)
            client.resolve(request.id, result)
            appendLog("Approved ${request.kind}: ${short(result.txid ?: result.signature)}")
        } catch (err: MwaOperationException) {
            client.reject(request.id, err)
            appendLog("Rejected ${request.kind}: ${err.code} ${err.message}")
        } catch (err: Exception) {
            val wrapped = MwaOperationException("WALLET_ERROR", err.message ?: err.javaClass.simpleName, err)
            client.reject(request.id, wrapped)
            appendLog("Failed ${request.kind}: ${wrapped.message}")
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
                AgentMwaLog.warn("MainActivity", label, "FAIL", "user action failed", mapOf("code" to err.code, "message" to err.message))
            } catch (err: Exception) {
                appendLog("ERROR: ${err.message ?: err.javaClass.simpleName}")
                AgentMwaLog.warn("MainActivity", label, "FAIL", "user action failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
            } finally {
                busy = false
                renderState()
            }
        }
    }

    private fun renderState() {
        val active = controller.activeAuthorization()
        val cached = controller.cachedAuthorizations()
        statusView.text = buildString {
            appendLine("Wallet: ${active?.publicKeyBase58?.let { short(it) } ?: "not connected"}")
            appendLine("Cluster: ${active?.cluster?.id ?: selectedCluster().id}")
            appendLine("Wallet package: ${active?.walletPackage?.ifBlank { "(unknown)" } ?: "(none)"}")
            appendLine("Cached accounts: ${cached.size}${if (cached.isNotEmpty()) " (latest ${short(cached.maxBy { it.timestampUnixSeconds }.publicKeyBase58)})" else ""}")
            appendLine("Bridge: ${if (bridgeClient != null) "connected" else "offline"}")
        }
        actionButtons.forEach { it.isEnabled = !busy }
        clusterSpinner.isEnabled = !busy && bridgeClient == null
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
            iconUri = "$origin/favicon.ico",
        )
    }

    private fun decodeTransactionInput(): ByteArray {
        val value = transactionInput.text.toString().trim()
        if (value.isBlank()) {
            throw MwaOperationException("INVALID_PAYLOADS", "Paste a base64 serialized transaction first.")
        }
        return Base64.decode(value, Base64.DEFAULT)
    }

    private fun appendLog(line: String) {
        if (!::logView.isInitialized) return
        val prefix = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        logView.text = ("$prefix  $line\n${logView.text}").take(8_000)
    }

    private fun label(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 12f
            setPadding(0, dp(8), 0, dp(3))
        }

    private fun section(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 18f
            setPadding(0, dp(18), 0, dp(8))
        }

    private fun button(text: String, onClick: () -> Unit): Button =
        Button(this).apply {
            this.text = text
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
