package com.agentic.wallet.mwa

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.activity.ComponentActivity
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.TransactionParams
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient.AuthorizationResult
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class MwaController(
    private val context: Context,
    private val identity: AgentMwaIdentity,
    private val cache: AuthCache = AuthCache(context),
) {
    private var activeRecord: AgentMwaAuthRecord? = null

    fun activeAuthorization(): AgentMwaAuthRecord? = activeRecord

    fun cachedAuthorizations(): List<AgentMwaAuthRecord> = cache.all()

    fun reconnectLatest(cluster: AgentCluster = cache.latest()?.cluster ?: AgentCluster.Devnet): AgentMwaAuthRecord? {
        val latest = cache.latest() ?: return null
        if (!latest.hasUsableAuthorization()) return null
        activeRecord = latest.copy(cluster = cluster, authenticated = true)
        cache.set(activeRecord!!)
        AgentMwaLog.info(
            "MwaController",
            "reconnectLatest",
            "SUCCESS",
            "cached authorization restored",
            mapOf("pubkey" to short(latest.publicKeyBase58), "walletPackage" to latest.walletPackage, "cluster" to cluster.id),
        )
        return activeRecord
    }

    fun reconnectForPubkey(pubkeyBase58: String, cluster: AgentCluster = AgentCluster.Devnet): AgentMwaAuthRecord? {
        val record = cache.get(pubkeyBase58) ?: return null
        if (!record.hasUsableAuthorization()) return null
        activeRecord = record.copy(cluster = cluster, authenticated = true)
        cache.set(activeRecord!!)
        AgentMwaLog.info(
            "MwaController",
            "reconnectForPubkey",
            "SUCCESS",
            "cached authorization restored",
            mapOf("pubkey" to short(pubkeyBase58), "walletPackage" to record.walletPackage, "cluster" to cluster.id),
        )
        return activeRecord
    }

    fun disconnect() {
        val record = activeRecord
        if (record != null) {
            cache.set(record.copy(authenticated = false))
        }
        activeRecord = null
        AgentMwaLog.info("MwaController", "disconnect", "DONE", "local session disconnected with cache retained")
    }

    fun clearTransientState(reason: String) {
        AgentMwaLog.info("MwaController", "clearTransientState", "DONE", "transient state cleared", mapOf("reason" to reason))
    }

    fun clearStateFullReset(reason: String) {
        val pubkey = activeRecord?.publicKeyBase58 ?: cache.latest()?.publicKeyBase58.orEmpty()
        activeRecord = null
        if (pubkey.isNotBlank()) {
            cache.clear(pubkey, blacklistForSession = true)
        }
        AgentMwaLog.info("MwaController", "clearStateFullReset", "DONE", "authorization cleared", mapOf("reason" to reason, "pubkey" to short(pubkey)))
    }

    suspend fun deauthorizeRemote(activity: ComponentActivity, reason: String) = withKeepAlive("deauthorizeRemote") {
        val record = activeRecord ?: cache.latest()
        if (record?.hasUsableAuthorization() != true) {
            clearStateFullReset(reason)
            AgentMwaLog.info("MwaController", "deauthorizeRemote", "SKIP", "no usable authorization to deauthorize", mapOf("reason" to reason))
            return@withKeepAlive
        }
        AgentMwaLog.info(
            "MwaController",
            "deauthorizeRemote",
            "START",
            "opening wallet deauthorize",
            mapOf("reason" to reason, "pubkey" to short(record.publicKeyBase58), "walletPackage" to record.walletPackage),
        )
        val adapter = newAdapter(record.cluster, record)
        try {
            when (val result = adapter.disconnect(ActivityResultSender(activity))) {
                is TransactionResult.Success -> {
                    AgentMwaLog.info("MwaController", "deauthorizeRemote", "SUCCESS", "wallet deauthorized authorization token", mapOf("pubkey" to short(record.publicKeyBase58)))
                }
                is TransactionResult.NoWalletFound -> {
                    AgentMwaLog.warn("MwaController", "deauthorizeRemote", "STEP_REMOTE_SKIP", "wallet not found; clearing local authorization", mapOf("pubkey" to short(record.publicKeyBase58)))
                }
                is TransactionResult.Failure -> {
                    val classified = classifyFailure(result.e)
                    AgentMwaLog.warn(
                        "MwaController",
                        "deauthorizeRemote",
                        "STEP_REMOTE_FAIL",
                        "wallet deauthorize failed; clearing local authorization",
                        mapOf("code" to classified.code, "message" to classified.message),
                    )
                }
            }
        } finally {
            activeRecord = null
            cache.clear(record.publicKeyBase58, blacklistForSession = true)
            AgentMwaLog.info("MwaController", "deauthorizeRemote", "DONE", "local authorization cleared", mapOf("reason" to reason, "pubkey" to short(record.publicKeyBase58)))
        }
    }

    fun clearAllCachedAuthorizations() {
        activeRecord = null
        cache.clearAll()
        AgentMwaLog.info("MwaController", "clearAllCachedAuthorizations", "DONE", "all authorizations cleared")
    }

    suspend fun connect(
        activity: ComponentActivity,
        cluster: AgentCluster,
        targetWalletPackage: String = "",
        forceFresh: Boolean = true,
    ): AgentMwaAuthRecord = withKeepAlive("connect") {
        cache.clearBlacklist()
        AgentMwaLog.info(
            "MwaController",
            "connect",
            "START",
            "opening wallet authorization",
            mapOf("cluster" to cluster.id, "targetWalletPackage" to targetWalletPackage, "forceFresh" to forceFresh),
        )
        val sender = ActivityResultSender(activity)
        val adapter = newAdapter(cluster, if (forceFresh) null else activeRecord)
        when (val result = adapter.connect(sender)) {
            is TransactionResult.Success -> {
                val record = applyAuthorization(result.authResult, cluster, targetWalletPackage)
                AgentMwaLog.info(
                    "MwaController",
                    "connect",
                    "SUCCESS",
                    "wallet authorized",
                    mapOf("pubkey" to short(record.publicKeyBase58), "walletPackage" to record.walletPackage, "authLen" to record.authToken.length),
                )
                record
            }
            is TransactionResult.NoWalletFound -> throw MwaOperationException("NO_WALLET_FOUND", "No MWA-compatible wallet was found.")
            is TransactionResult.Failure -> throw classifyFailure(result.e)
        }
    }

    suspend fun connectWithSignIn(
        activity: ComponentActivity,
        cluster: AgentCluster,
        domain: String,
        statement: String,
    ): AgentMwaSigningResult = withKeepAlive("connectWithSignIn") {
        if (domain.isBlank() || statement.isBlank()) {
            throw MwaOperationException("INVALID_REQUEST", "SIWS domain and statement are required.")
        }
        val record = activeRecord
        if (record?.walletPackage?.let { !WalletRegistry.supportsSiws(it) } == true) {
            throw MwaOperationException("SIWS_UNSUPPORTED_FOR_WALLET", "This wallet is known to fail Sign In With Solana over MWA.")
        }
        val sender = ActivityResultSender(activity)
        val adapter = newAdapter(cluster, null)
        val payload = SignInWithSolana.Payload(domain, statement)
        when (val result = adapter.signIn(sender, payload)) {
            is TransactionResult.Success -> {
                val applied = applyAuthorization(result.authResult, cluster, record?.walletPackage.orEmpty())
                val signIn = result.authResult.signInResult ?: result.payload
                AgentMwaSigningResult(signature = Base58.encode(signIn.signature))
                    .also {
                        AgentMwaLog.info(
                            "MwaController",
                            "connectWithSignIn",
                            "SUCCESS",
                            "wallet signed SIWS payload",
                            mapOf("pubkey" to short(applied.publicKeyBase58), "signedMessageBytes" to signIn.signedMessage.size),
                        )
                    }
            }
            is TransactionResult.NoWalletFound -> throw MwaOperationException("NO_WALLET_FOUND", "No MWA-compatible wallet was found.")
            is TransactionResult.Failure -> throw classifyFailure(result.e)
        }
    }

    suspend fun getCapabilities(activity: ComponentActivity): String = privileged(activity, "getCapabilities") {
        val record = requireActive()
        val adapter = newAdapter(record.cluster, record)
        when (val result = adapter.transact(ActivityResultSender(activity)) { _ -> getCapabilities() }) {
            is TransactionResult.Success -> {
                val updatedRecord = applyAuthorization(result.authResult, record.cluster, record.walletPackage)
                val caps = result.payload
                val csv = "maxTransactions=${caps.maxTransactionsPerSigningRequest}," +
                    "maxMessages=${caps.maxMessagesPerSigningRequest}," +
                    "supportsCloneAuth=${caps.supportsCloneAuthorization}," +
                    "supportsSignAndSend=${caps.supportsSignAndSendTransactions}," +
                    "supportedVersions=${caps.supportedTransactionVersions?.joinToString(";") ?: ""}," +
                    "optionalFeatures=${caps.supportedOptionalFeatures?.joinToString(";") ?: ""}"
                val saved = updatedRecord.copy(capabilitiesCsv = csv)
                activeRecord = saved
                cache.set(saved)
                AgentMwaLog.info("MwaController", "getCapabilities", "SUCCESS", "capabilities received", mapOf("result" to csv))
                csv
            }
            is TransactionResult.NoWalletFound -> throw MwaOperationException("NO_WALLET_FOUND", "No MWA-compatible wallet was found.")
            is TransactionResult.Failure -> throw classifyFailure(result.e)
        }
    }

    suspend fun signMessage(activity: ComponentActivity, message: String): AgentMwaSigningResult =
        signMessages(activity, arrayOf(message.toByteArray(Charsets.UTF_8))).first()

    suspend fun signMessages(activity: ComponentActivity, messages: Array<ByteArray>): List<AgentMwaSigningResult> =
        privileged(activity, "signMessages") {
            if (messages.isEmpty() || messages.any { it.isEmpty() }) {
                throw MwaOperationException("INVALID_PAYLOADS", "SignMessages requires non-empty message bytes.")
            }
            val record = requireActive()
            if (WalletRegistry.messageSigningUnsupported(record.walletPackage)) {
                throw MwaOperationException("WALLET_SIGN_MESSAGES_UNSUPPORTED", "This wallet does not implement sign_messages over Android MWA. Use transaction signing for transaction approvals.")
            }
            val adapter = newAdapter(record.cluster, record)
            AgentMwaLog.info(
                "MwaController",
                "signMessages",
                "START",
                "opening wallet message approval",
                mapOf("count" to messages.size, "firstBytes" to messages.first().size, "walletPackage" to record.walletPackage),
            )
            val result = withTimeoutOrNull(SIGN_MESSAGES_TIMEOUT_MS) {
                adapter.transact(ActivityResultSender(activity)) { _ ->
                    val addresses = Array(messages.size) { record.publicKeyBytes }
                    val detached = signMessagesDetached(messages, addresses)
                    detached.messages.map { it.signatures.firstOrNull() ?: ByteArray(0) }.toTypedArray()
                }
            } ?: throw MwaOperationException("WALLET_HUNG", "Wallet did not reply to sign_messages within ${SIGN_MESSAGES_TIMEOUT_MS / 1000}s.")
            when (result) {
                is TransactionResult.Success -> {
                    applyAuthorization(result.authResult, record.cluster, record.walletPackage)
                    result.payload.map { signature ->
                        if (signature.isEmpty()) throw MwaOperationException("EMPTY_SIGNATURE", "Wallet returned an empty signature.")
                        AgentMwaSigningResult(signature = Base58.encode(signature))
                    }.also {
                        AgentMwaLog.info("MwaController", "signMessages", "SUCCESS", "messages signed", mapOf("count" to it.size, "firstSignature" to short(it.firstOrNull()?.signature.orEmpty())))
                    }
                }
                is TransactionResult.NoWalletFound -> throw MwaOperationException("NO_WALLET_FOUND", "No MWA-compatible wallet was found.")
                is TransactionResult.Failure -> throw classifyFailure(result.e)
            }
        }

    suspend fun signTransaction(activity: ComponentActivity, transaction: ByteArray): AgentMwaSigningResult =
        signTransactions(activity, arrayOf(transaction)).first()

    suspend fun signTransactions(activity: ComponentActivity, transactions: Array<ByteArray>): List<AgentMwaSigningResult> =
        privileged(activity, "signTransactions") {
            if (transactions.isEmpty() || transactions.any { it.isEmpty() }) {
                throw MwaOperationException("INVALID_PAYLOADS", "SignTransactions requires non-empty transaction bytes.")
            }
            val record = requireActive()
            if (WalletRegistry.standaloneSignTransactionUnsupported(record.walletPackage)) {
                throw MwaOperationException("JUPITER_SIGN_TRANSACTION_UNSUPPORTED", "Jupiter does not support standalone sign_transactions. Use Sign And Send.")
            }
            val adapter = newAdapter(record.cluster, record)
            AgentMwaLog.info(
                "MwaController",
                "signTransactions",
                "START",
                "opening wallet transaction approval",
                mapOf("count" to transactions.size, "first" to describeTransaction(transactions.first()), "walletPackage" to record.walletPackage),
            )
            when (val result = adapter.transact(ActivityResultSender(activity)) { _ -> signTransactions(transactions) }) {
                is TransactionResult.Success -> {
                    applyAuthorization(result.authResult, record.cluster, record.walletPackage)
                    val signed = result.payload.signedPayloads?.filterNotNull().orEmpty()
                    if (signed.isEmpty()) throw MwaOperationException("EMPTY_SIGNED_TRANSACTION", "Wallet returned no signed transactions.")
                    signed.map { AgentMwaSigningResult(signature = Base64.encodeToString(it, Base64.NO_WRAP)) }
                        .also {
                            AgentMwaLog.info("MwaController", "signTransactions", "SUCCESS", "transactions signed", mapOf("count" to it.size, "firstBytes" to signed.first().size))
                        }
                }
                is TransactionResult.NoWalletFound -> throw MwaOperationException("NO_WALLET_FOUND", "No MWA-compatible wallet was found.")
                is TransactionResult.Failure -> throw classifyFailure(result.e)
            }
        }

    suspend fun signAndSendTransaction(activity: ComponentActivity, transaction: ByteArray): AgentMwaSigningResult =
        signAndSendTransactions(activity, arrayOf(transaction)).first()

    suspend fun signAndSendTransactions(activity: ComponentActivity, transactions: Array<ByteArray>): List<AgentMwaSigningResult> =
        privileged(activity, "signAndSendTransactions") {
            if (transactions.isEmpty() || transactions.any { it.isEmpty() }) {
                throw MwaOperationException("INVALID_PAYLOADS", "SignAndSendTransactions requires non-empty transaction bytes.")
            }
            val record = requireActive()
            val forceSignThenRpc = WalletRegistry.forceSignThenRpc(record.walletPackage)
            val routeNative = !forceSignThenRpc
            val route = if (routeNative) "native_mwa" else "sign_then_rpc"
            AgentMwaLog.info(
                "MwaController",
                "signAndSendTransactions",
                "START",
                "opening wallet sign-and-send approval",
                mapOf("route" to route, "reason" to if (forceSignThenRpc) "backpack_native_unsupported" else "native_default", "count" to transactions.size, "first" to describeTransaction(transactions.first()), "walletPackage" to record.walletPackage),
            )
            val adapter = newAdapter(record.cluster, record)
            if (routeNative) {
                signAndSendNative(activity, adapter, record, transactions)
            } else {
                signThenRpc(activity, adapter, record, transactions)
            }
        }

    fun capabilitiesJson(): JSONObject {
        val record = requireActive()
        val messageSupported = !WalletRegistry.messageSigningUnsupported(record.walletPackage)
        val standaloneTxSupported = !WalletRegistry.standaloneSignTransactionUnsupported(record.walletPackage)
        return JSONObject()
            .put("backend", "android-native-mwa")
            .put("cluster", JSONArray().put(record.cluster.id))
            .put(
                "supports",
                JSONObject()
                    .put("signMessage", messageSupported)
                    .put("signTransaction", standaloneTxSupported)
                    .put("signAndSendTransaction", true)
                    .put("multiSign", true)
                    .put("simulationPreview", false),
            )
            .put("address", record.publicKeyBase58)
    }

    suspend fun signBridgeRequest(activity: ComponentActivity, request: AgentMwaBridgeRequest): AgentMwaSigningResult {
        val active = requireActive()
        if (request.cluster != active.cluster) {
            throw MwaOperationException("CLUSTER_MISMATCH", "Bridge request targets ${request.cluster.id}; Android wallet is connected to ${active.cluster.id}.")
        }
        return when (request.kind) {
            "sign_message" -> {
                val message = decodePayload(request.payloadData, request.payloadEncoding)
                signMessages(activity, arrayOf(message)).first()
            }
            "sign_transaction" -> signTransaction(activity, decodePayload(request.payloadData, request.payloadEncoding))
            "sign_and_send_transaction" -> signAndSendTransaction(activity, decodePayload(request.payloadData, request.payloadEncoding))
            else -> throw MwaOperationException("UNSUPPORTED_METHOD", "Unsupported bridge signing kind: ${request.kind}")
        }
    }

    private suspend fun signAndSendNative(
        activity: ComponentActivity,
        adapter: MobileWalletAdapter,
        record: AgentMwaAuthRecord,
        transactions: Array<ByteArray>,
    ): List<AgentMwaSigningResult> {
        val minContextSlot = fetchLatestContextSlot(record.cluster).takeIf { it > 0 }?.toInt()
        val params = TransactionParams(minContextSlot, "confirmed", true, 3, null)
        val result = withTimeoutOrNull(SIGN_AND_SEND_TIMEOUT_MS) {
            adapter.transact(ActivityResultSender(activity)) { _ ->
                signAndSendTransactions(transactions, params)
            }
        } ?: throw MwaOperationException("WALLET_HUNG", "Wallet did not reply to sign_and_send_transactions within ${SIGN_AND_SEND_TIMEOUT_MS / 1000}s.")
        return when (result) {
            is TransactionResult.Success -> {
                applyAuthorization(result.authResult, record.cluster, record.walletPackage)
                val signatures = result.payload.signatures?.filterNotNull().orEmpty()
                if (signatures.isEmpty()) throw MwaOperationException("EMPTY_SIGNATURE", "Wallet returned no transaction signatures.")
                signatures.map {
                    val txid = Base58.encode(it)
                    AgentMwaSigningResult(signature = txid, txid = txid)
                }.also {
                    AgentMwaLog.info("MwaController", "signAndSendTransactions", "SUCCESS", "native sign-and-send complete", mapOf("count" to it.size, "firstTxid" to short(it.first().txid.orEmpty()), "minContextSlot" to (minContextSlot ?: "")))
                }
            }
            is TransactionResult.NoWalletFound -> throw MwaOperationException("NO_WALLET_FOUND", "No MWA-compatible wallet was found.")
            is TransactionResult.Failure -> throw classifyFailure(result.e)
        }
    }

    private suspend fun signThenRpc(
        activity: ComponentActivity,
        adapter: MobileWalletAdapter,
        record: AgentMwaAuthRecord,
        transactions: Array<ByteArray>,
    ): List<AgentMwaSigningResult> {
        val balance = getConnectedBalanceLamports(record)
        AgentMwaLog.info("MwaController", "signThenRpc", "STEP_BALANCE", "balance checked", mapOf("lamports" to balance, "threshold" to MIN_FEE_PAYER_LAMPORTS))
        if (balance in 0 until MIN_FEE_PAYER_LAMPORTS) {
            throw MwaOperationException("INSUFFICIENT_FUNDS_FOR_RENT", "Connected account has $balance lamports; at least $MIN_FEE_PAYER_LAMPORTS are required before opening the wallet.")
        }
        val result = withTimeoutOrNull(SIGN_AND_SEND_TIMEOUT_MS) {
            adapter.transact(ActivityResultSender(activity)) { _ -> signTransactions(transactions) }
        } ?: throw MwaOperationException("WALLET_HUNG", "Wallet did not reply to sign_transactions within ${SIGN_AND_SEND_TIMEOUT_MS / 1000}s.")
        return when (result) {
            is TransactionResult.Success -> {
                applyAuthorization(result.authResult, record.cluster, record.walletPackage)
                val signed = result.payload.signedPayloads?.filterNotNull().orEmpty()
                if (signed.isEmpty()) throw MwaOperationException("EMPTY_SIGNED_TRANSACTION", "Wallet returned no signed transactions.")
                signed.mapIndexed { index, tx ->
                    val txid = sendSignedTransactionViaRpc(record.cluster, tx)
                    AgentMwaLog.info("MwaController", "signThenRpc", "STEP_RPC_SENT", "signed transaction broadcast", mapOf("txIndex" to index, "txid" to short(txid), "signedBytes" to tx.size, "signedSha256" to sha256First8(tx)))
                    AgentMwaSigningResult(signature = txid, txid = txid)
                }.also {
                    AgentMwaLog.info("MwaController", "signAndSendTransactions", "SUCCESS", "sign-then-rpc complete", mapOf("count" to it.size, "firstTxid" to short(it.first().txid.orEmpty())))
                }
            }
            is TransactionResult.NoWalletFound -> throw MwaOperationException("NO_WALLET_FOUND", "No MWA-compatible wallet was found.")
            is TransactionResult.Failure -> throw classifyFailure(result.e)
        }
    }

    private suspend fun <T> privileged(
        activity: ComponentActivity,
        method: String,
        block: suspend () -> T,
    ): T = withKeepAlive(method) {
        try {
            block()
        } catch (err: MwaOperationException) {
            if (err.code != "WALLET_AUTH_MISMATCH") throw err
            val previous = requireActive()
            AgentMwaLog.warn("MwaController", method, "STEP_AUTH_MISMATCH", "attempting one-shot reauthorization", mapOf("pubkey" to short(previous.publicKeyBase58), "walletPackage" to previous.walletPackage))
            val reauthorized = connect(activity, previous.cluster, previous.walletPackage, forceFresh = true)
            if (reauthorized.publicKeyBase58 != previous.publicKeyBase58) {
                throw MwaOperationException("WALLET_CHANGED", "Wallet changed during reauthorization. Reconnect with the intended account.")
            }
            block()
        }
    }

    private suspend fun <T> withKeepAlive(method: String, block: suspend () -> T): T {
        startKeepAlive(method)
        return try {
            block()
        } finally {
            stopKeepAlive(method)
        }
    }

    private fun startKeepAlive(method: String) {
        try {
            val intent = Intent(context, MwaKeepAliveService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                @Suppress("DEPRECATION")
                context.startService(intent)
            }
            AgentMwaLog.info("MwaController", method, "STEP_KEEPALIVE_START", "keepalive requested")
        } catch (err: Exception) {
            AgentMwaLog.warn("MwaController", method, "STEP_KEEPALIVE_FAIL", "keepalive start failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        }
    }

    private fun stopKeepAlive(method: String) {
        try {
            context.stopService(Intent(context, MwaKeepAliveService::class.java))
            AgentMwaLog.info("MwaController", method, "STEP_KEEPALIVE_STOP", "keepalive stopped")
        } catch (err: Exception) {
            AgentMwaLog.warn("MwaController", method, "STEP_KEEPALIVE_STOP_FAIL", "keepalive stop failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        }
    }

    private fun newAdapter(cluster: AgentCluster, record: AgentMwaAuthRecord?): MobileWalletAdapter {
        val adapter = MobileWalletAdapter(
            ConnectionIdentity(
                Uri.parse(identity.uri),
                Uri.parse(identity.iconUri),
                identity.name,
            ),
        )
        adapter.blockchain = cluster.blockchain()
        if (record?.authToken?.isNotBlank() == true) {
            adapter.authToken = record.authToken
        }
        if (record?.walletUriBase?.isNotBlank() == true) {
            restoreWalletUriBase(adapter, record.walletUriBase)
        }
        return adapter
    }

    private fun restoreWalletUriBase(adapter: MobileWalletAdapter, walletUriBase: String) {
        val uri = runCatching { Uri.parse(walletUriBase) }.getOrNull()
        if (uri?.scheme != "https") {
            AgentMwaLog.warn("MwaController", "restoreWalletUriBase", "SKIP", "cached wallet URI is not HTTPS", mapOf("walletUriBase" to walletUriBase))
            return
        }
        try {
            val field = MobileWalletAdapter::class.java.getDeclaredField("walletUriBase")
            field.isAccessible = true
            field.set(adapter, uri)
            AgentMwaLog.info("MwaController", "restoreWalletUriBase", "DONE", "cached wallet URI restored", mapOf("walletUriBase" to walletUriBase))
        } catch (err: Exception) {
            AgentMwaLog.warn("MwaController", "restoreWalletUriBase", "FAIL", "cached wallet URI restore failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        }
    }

    private fun applyAuthorization(
        auth: AuthorizationResult,
        cluster: AgentCluster,
        targetWalletPackage: String,
    ): AgentMwaAuthRecord {
        val publicKeyBytes = auth.publicKey ?: auth.accounts?.firstOrNull()?.publicKey ?: ByteArray(0)
        val publicKeyBase58 = Base58.encode(publicKeyBytes)
        val walletUriBase = auth.walletUriBase?.toString().orEmpty()
        val walletPackage = WalletRegistry.inferPackage(walletUriBase, targetWalletPackage)
        val record = AgentMwaAuthRecord(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            authToken = auth.authToken.orEmpty(),
            walletUriBase = walletUriBase,
            walletPackage = walletPackage,
            walletType = WalletRegistry.walletType(walletPackage, walletUriBase),
            accountLabel = auth.accountLabel ?: auth.accounts?.firstOrNull()?.accountLabel ?: "",
            cluster = cluster,
            timestampUnixSeconds = System.currentTimeMillis() / 1000L,
            authenticated = true,
            capabilitiesCsv = activeRecord?.capabilitiesCsv.orEmpty(),
        )
        activeRecord = record
        cache.set(record)
        return record
    }

    private fun requireActive(): AgentMwaAuthRecord =
        activeRecord ?: throw MwaOperationException("UNAUTHORIZED", "No Android MWA wallet is connected.")

    private suspend fun fetchLatestContextSlot(cluster: AgentCluster): Long = try {
        val json = postJsonRpc(cluster.rpcUrl(), "getLatestBlockhash", """[{"commitment":"confirmed"}]""")
        val slot = json.optJSONObject("result")?.optJSONObject("context")?.optLong("slot", -1L) ?: -1L
        AgentMwaLog.info("MwaController", "fetchLatestContextSlot", "DONE", "context slot fetched", mapOf("slot" to slot, "rpc" to cluster.rpcUrl()))
        slot
    } catch (err: Exception) {
        AgentMwaLog.warn("MwaController", "fetchLatestContextSlot", "FAIL", "context slot fetch failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        -1L
    }

    private suspend fun getConnectedBalanceLamports(record: AgentMwaAuthRecord): Long = try {
        val json = postJsonRpc(record.cluster.rpcUrl(), "getBalance", """["${record.publicKeyBase58}",{"commitment":"confirmed"}]""")
        json.optJSONObject("result")?.optLong("value", -1L) ?: -1L
    } catch (err: Exception) {
        AgentMwaLog.warn("MwaController", "getConnectedBalanceLamports", "FAIL", "balance lookup failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        -1L
    }

    private suspend fun sendSignedTransactionViaRpc(cluster: AgentCluster, signedTx: ByteArray): String {
        val encoded = Base64.encodeToString(signedTx, Base64.NO_WRAP)
        val params = """["$encoded",{"encoding":"base64","skipPreflight":false,"preflightCommitment":"confirmed","maxRetries":3}]"""
        val json = postJsonRpc(cluster.rpcUrl(), "sendTransaction", params)
        val error = json.optJSONObject("error")
        if (error != null) {
            throw MwaOperationException("RPC_BROADCAST_FAILED", error.optString("message", error.toString()))
        }
        val result = json.optString("result", "")
        if (result.isBlank()) throw MwaOperationException("RPC_BROADCAST_FAILED", "RPC returned an empty transaction id.")
        return result
    }

    private suspend fun postJsonRpc(rpcUrl: String, method: String, paramsJson: String): JSONObject = withContext(Dispatchers.IO) {
        val body = """{"jsonrpc":"2.0","id":1,"method":"$method","params":$paramsJson}"""
        val conn = (URL(rpcUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 30_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        conn.disconnect()
        JSONObject(text)
    }

    private fun decodePayload(data: String, encoding: String): ByteArray = when (encoding) {
        "utf8" -> data.toByteArray(Charsets.UTF_8)
        "base64" -> Base64.decode(data, Base64.DEFAULT)
        else -> throw MwaOperationException("INVALID_PAYLOADS", "Unsupported payload encoding: $encoding")
    }

    private fun describeTransaction(tx: ByteArray): String =
        "tx_bytes=${tx.size} sha256_8=${sha256First8(tx)} first12=${hexPrefix(tx, 12)}"

    private fun sha256First8(bytes: ByteArray): String = hexPrefix(MessageDigest.getInstance("SHA-256").digest(bytes), 8)

    private fun hexPrefix(bytes: ByteArray, count: Int): String =
        bytes.take(count).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun short(value: String, head: Int = 8, tail: Int = 8): String =
        if (value.length <= head + tail + 3) value else "${value.take(head)}...${value.takeLast(tail)}"

    private fun classifyFailure(err: Throwable?): MwaOperationException {
        val message = err?.message.orEmpty()
        val lower = message.lowercase()
        val code = when {
            lower.contains("auth_token") || lower.contains("auth token") || lower.contains("not authorized") || lower.contains("reauthorize") -> "WALLET_AUTH_MISMATCH"
            lower.contains("user rejected") || lower.contains("declined") || lower.contains("cancelled") || lower.contains("canceled") -> "USER_REJECTED"
            lower.contains("timeout") || lower.contains("timed out") -> "WALLET_HUNG"
            lower.contains("jsondecodingexception") || lower.contains("class discriminator") -> "WALLET_NATIVE_SIGN_AND_SEND_UNSUPPORTED"
            lower.contains("mincontextslot") -> "PHANTOM_REQUIRES_MIN_CONTEXT_SLOT"
            lower.contains("invalid") || lower.contains("payload") -> "INVALID_PAYLOADS"
            else -> "WALLET_ERROR"
        }
        return MwaOperationException(code, message.ifBlank { err?.javaClass?.simpleName ?: "Wallet operation failed." }, err)
    }

    companion object {
        private const val SIGN_MESSAGES_TIMEOUT_MS = 20_000L
        private const val SIGN_AND_SEND_TIMEOUT_MS = 45_000L
        private const val MIN_FEE_PAYER_LAMPORTS = 1_000_000L
    }
}

class MwaOperationException(
    val code: String,
    override val message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
