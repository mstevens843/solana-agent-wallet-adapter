package com.agentic.wallet.mwa

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.activity.ComponentActivity
import com.agentic.wallet.BuildConfig
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.TransactionParams
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient.AuthorizationResult
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
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
        AgentMwaLog.info(
            "MwaController",
            "reconnectLatest",
            "START",
            "attempting cached authorization restore",
            mapOf("cluster" to cluster.id, "cachedCount" to cache.all().size, "latestPubkey" to cache.latest()?.publicKeyBase58.orEmpty()),
        )
        val latest = cache.latest()
        if (latest == null) {
            AgentMwaLog.warn(
                "MwaController",
                "reconnectLatest",
                "RESULT_FAIL",
                "no cached authorization available",
                mapOf("cluster" to cluster.id, "cachedCount" to cache.all().size),
            )
            return null
        }
        if (!latest.hasUsableAuthorization()) {
            AgentMwaLog.warn(
                "MwaController",
                "reconnectLatest",
                "RESULT_FAIL",
                "cached authorization is missing required auth material",
                mapOf("pubkey" to latest.publicKeyBase58, "authLen" to latest.authToken.length, "walletPackage" to latest.walletPackage),
            )
            return null
        }
        activeRecord = latest.copy(cluster = cluster, authenticated = true)
        cache.set(activeRecord!!)
        AgentMwaLog.info(
            "MwaController",
            "reconnectLatest",
            "SUCCESS",
            "cached authorization restored",
            mapOf("pubkey" to latest.publicKeyBase58, "walletPackage" to latest.walletPackage, "cluster" to cluster.id, "authLen" to latest.authToken.length),
        )
        return activeRecord
    }

    fun reconnectForPubkey(pubkeyBase58: String, cluster: AgentCluster = AgentCluster.Devnet): AgentMwaAuthRecord? {
        AgentMwaLog.info(
            "MwaController",
            "reconnectForPubkey",
            "START",
            "attempting cached authorization restore for pubkey",
            mapOf("pubkey" to pubkeyBase58, "cluster" to cluster.id),
        )
        val record = cache.get(pubkeyBase58)
        if (record == null) {
            AgentMwaLog.warn("MwaController", "reconnectForPubkey", "RESULT_FAIL", "cached authorization not found", mapOf("pubkey" to pubkeyBase58, "cluster" to cluster.id))
            return null
        }
        if (!record.hasUsableAuthorization()) {
            AgentMwaLog.warn(
                "MwaController",
                "reconnectForPubkey",
                "RESULT_FAIL",
                "cached authorization is missing required auth material",
                mapOf("pubkey" to pubkeyBase58, "authLen" to record.authToken.length, "walletPackage" to record.walletPackage),
            )
            return null
        }
        activeRecord = record.copy(cluster = cluster, authenticated = true)
        cache.set(activeRecord!!)
        AgentMwaLog.info(
            "MwaController",
            "reconnectForPubkey",
            "SUCCESS",
            "cached authorization restored",
            mapOf("pubkey" to pubkeyBase58, "walletPackage" to record.walletPackage, "cluster" to cluster.id, "authLen" to record.authToken.length),
        )
        return activeRecord
    }

    fun disconnect() {
        val record = activeRecord
        AgentMwaLog.info(
            "MwaController",
            "disconnect",
            "START",
            "disconnect requested",
            mapOf("hadActive" to (record != null), "pubkey" to record?.publicKeyBase58.orEmpty(), "walletPackage" to record?.walletPackage.orEmpty()),
        )
        if (record != null) {
            cache.set(record.copy(authenticated = false))
        }
        activeRecord = null
        AgentMwaLog.info("MwaController", "disconnect", "DONE", "local session disconnected with cache retained", mapOf("retainedPubkey" to record?.publicKeyBase58.orEmpty()))
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
        AgentMwaLog.info("MwaController", "clearStateFullReset", "DONE", "authorization cleared", mapOf("reason" to reason, "pubkey" to pubkey))
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
            mapOf("reason" to reason, "pubkey" to record.publicKeyBase58, "walletPackage" to record.walletPackage, "authLen" to record.authToken.length),
        )
        val adapter = newAdapter(record.cluster, record)
        try {
            when (val result = adapter.disconnect(ActivityResultSender(activity))) {
                is TransactionResult.Success -> {
                    AgentMwaLog.info("MwaController", "deauthorizeRemote", "SUCCESS", "wallet deauthorized authorization token", mapOf("pubkey" to record.publicKeyBase58))
                }
                is TransactionResult.NoWalletFound -> {
                    AgentMwaLog.warn("MwaController", "deauthorizeRemote", "STEP_REMOTE_SKIP", "wallet not found; clearing local authorization", mapOf("pubkey" to record.publicKeyBase58, "walletPackage" to record.walletPackage))
                }
                is TransactionResult.Failure -> {
                    val classified = classifyFailure(result.e)
                    AgentMwaLog.warn(
                        "MwaController",
                        "deauthorizeRemote",
                        "STEP_REMOTE_FAIL",
                        "wallet deauthorize failed; clearing local authorization",
                        mapOf("code" to classified.code, "message" to classified.message) + AgentMwaLog.errorMetadata(result.e),
                    )
                }
            }
        } finally {
            activeRecord = null
            cache.clear(record.publicKeyBase58, blacklistForSession = true)
            AgentMwaLog.info("MwaController", "deauthorizeRemote", "DONE", "local authorization cleared", mapOf("reason" to reason, "pubkey" to record.publicKeyBase58))
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
                    authRecordMetadata(record),
                )
                record
            }
            is TransactionResult.NoWalletFound -> throwNoWallet("connect")
            is TransactionResult.Failure -> throwClassified("connect", "FAIL_WALLET_RESULT", result.e)
        }
    }

    suspend fun connectWithSignIn(
        activity: ComponentActivity,
        cluster: AgentCluster,
        domain: String,
        statement: String,
    ): AgentMwaSigningResult = withKeepAlive("connectWithSignIn") {
        if (domain.isBlank() || statement.isBlank()) {
            throwOperation(
                "connectWithSignIn",
                "FAIL_INVALID_SIWS_PAYLOAD",
                MwaOperationException("INVALID_REQUEST", "SIWS domain and statement are required."),
                mapOf("domain" to domain, "statement" to statement, "domainLen" to domain.length, "statementLen" to statement.length),
            )
        }
        val record = activeRecord
        if (record?.walletPackage?.let { !WalletRegistry.supportsSiws(it) } == true) {
            throwOperation(
                "connectWithSignIn",
                "FAIL_SIWS_UNSUPPORTED",
                MwaOperationException("SIWS_UNSUPPORTED_FOR_WALLET", "This wallet is known to fail Sign In With Solana over MWA."),
                authRecordMetadata(record),
            )
        }
        val sender = ActivityResultSender(activity)
        val adapter = newAdapter(cluster, null)
        val payload = SignInWithSolana.Payload(domain, statement)
        AgentMwaLog.info(
            "MwaController",
            "connectWithSignIn",
            "START",
            "opening wallet SIWS authorization",
            mapOf("cluster" to cluster.id, "domain" to domain, "statement" to statement, "statementLen" to statement.length),
        )
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
                            authRecordMetadata(applied) + AgentMwaLog.bytesMetadata("signedMessage", signIn.signedMessage, includeUtf8 = true) + mapOf("signature" to it.signature),
                        )
                    }
            }
            is TransactionResult.NoWalletFound -> throwNoWallet("connectWithSignIn")
            is TransactionResult.Failure -> throwClassified("connectWithSignIn", "FAIL_WALLET_RESULT", result.e)
        }
    }

    suspend fun getCapabilities(activity: ComponentActivity): String = privileged(activity, "getCapabilities") {
        val record = requireActive("getCapabilities")
        val adapter = newAdapter(record.cluster, record)
        AgentMwaLog.info("MwaController", "getCapabilities", "START", "opening wallet get_capabilities request", authRecordMetadata(record))
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
                AgentMwaLog.info(
                    "MwaController",
                    "getCapabilities",
                    "SUCCESS",
                    "capabilities received",
                    authRecordMetadata(saved) + mapOf(
                        "maxTransactions" to caps.maxTransactionsPerSigningRequest,
                        "maxMessages" to caps.maxMessagesPerSigningRequest,
                        "supportsCloneAuth" to caps.supportsCloneAuthorization,
                        "supportsSignAndSend" to caps.supportsSignAndSendTransactions,
                        "supportedVersions" to caps.supportedTransactionVersions?.joinToString(";").orEmpty(),
                        "optionalFeatures" to caps.supportedOptionalFeatures?.joinToString(";").orEmpty(),
                        "result" to csv,
                    ),
                )
                csv
            }
            is TransactionResult.NoWalletFound -> throwNoWallet("getCapabilities")
            is TransactionResult.Failure -> throwClassified("getCapabilities", "FAIL_WALLET_RESULT", result.e)
        }
    }

    suspend fun signMessage(activity: ComponentActivity, message: String): AgentMwaSigningResult =
        signMessages(activity, arrayOf(message.toByteArray(Charsets.UTF_8))).first()

    suspend fun signMessages(activity: ComponentActivity, messages: Array<ByteArray>): List<AgentMwaSigningResult> =
        privileged(activity, "signMessages") {
            if (messages.isEmpty() || messages.any { it.isEmpty() }) {
                throwOperation(
                    "signMessages",
                    "FAIL_INVALID_PAYLOADS",
                    MwaOperationException("INVALID_PAYLOADS", "SignMessages requires non-empty message bytes."),
                    mapOf("count" to messages.size, "emptyCount" to messages.count { it.isEmpty() }) + messagesMetadata(messages),
                )
            }
            val record = requireActive("signMessages")
            if (WalletRegistry.messageSigningUnsupported(record.walletPackage)) {
                throwOperation(
                    "signMessages",
                    "FAIL_WALLET_UNSUPPORTED",
                    MwaOperationException("WALLET_SIGN_MESSAGES_UNSUPPORTED", "This wallet does not implement sign_messages over Android MWA. Use transaction signing for transaction approvals."),
                    authRecordMetadata(record) + messagesMetadata(messages),
                )
            }
            val adapter = newAdapter(record.cluster, record)
            AgentMwaLog.info(
                "MwaController",
                "signMessages",
                "START",
                "opening wallet message approval",
                authRecordMetadata(record) + messagesMetadata(messages),
            )
            val result = withTimeoutOrNull(SIGN_MESSAGES_TIMEOUT_MS) {
                adapter.transact(ActivityResultSender(activity)) { _ ->
                    val addresses = Array(messages.size) { record.publicKeyBytes }
                    AgentMwaLog.info(
                        "MwaController",
                        "signMessages",
                        "STEP_MWA_CALL",
                        "calling signMessagesDetached",
                        mapOf("addressCount" to addresses.size, "addressesBase58" to addresses.joinToString(";") { Base58.encode(it) }) + messagesMetadata(messages),
                    )
                    val detached = signMessagesDetached(messages, addresses)
                    detached.messages.map { it.signatures.firstOrNull() ?: ByteArray(0) }.toTypedArray()
                }
            } ?: throwOperation(
                "signMessages",
                "FAIL_TIMEOUT",
                MwaOperationException("WALLET_HUNG", "Wallet did not reply to sign_messages within ${SIGN_MESSAGES_TIMEOUT_MS / 1000}s."),
                authRecordMetadata(record) + mapOf("timeoutMs" to SIGN_MESSAGES_TIMEOUT_MS) + messagesMetadata(messages),
            )
            when (result) {
                is TransactionResult.Success -> {
                    applyAuthorization(result.authResult, record.cluster, record.walletPackage)
                    result.payload.map { signature ->
                        if (signature.isEmpty()) {
                            throwOperation(
                                "signMessages",
                                "FAIL_EMPTY_SIGNATURE",
                                MwaOperationException("EMPTY_SIGNATURE", "Wallet returned an empty signature."),
                                authRecordMetadata(record) + mapOf("signatureCount" to result.payload.size),
                            )
                        }
                        AgentMwaSigningResult(signature = Base58.encode(signature))
                    }.also {
                        AgentMwaLog.info("MwaController", "signMessages", "SUCCESS", "messages signed", authRecordMetadata(record) + signingResultsMetadata(it))
                    }
                }
                is TransactionResult.NoWalletFound -> throwNoWallet("signMessages")
                is TransactionResult.Failure -> throwClassified("signMessages", "FAIL_WALLET_RESULT", result.e)
            }
        }

    suspend fun signTransaction(activity: ComponentActivity, transaction: ByteArray): AgentMwaSigningResult =
        signTransactions(activity, arrayOf(transaction)).first()

    suspend fun signTransactions(activity: ComponentActivity, transactions: Array<ByteArray>): List<AgentMwaSigningResult> =
        privileged(activity, "signTransactions") {
            if (transactions.isEmpty() || transactions.any { it.isEmpty() }) {
                throwOperation(
                    "signTransactions",
                    "FAIL_INVALID_PAYLOADS",
                    MwaOperationException("INVALID_PAYLOADS", "SignTransactions requires non-empty transaction bytes."),
                    mapOf("count" to transactions.size, "emptyCount" to transactions.count { it.isEmpty() }) + transactionsMetadata(transactions),
                )
            }
            val record = requireActive("signTransactions")
            if (WalletRegistry.standaloneSignTransactionUnsupported(record.walletPackage)) {
                throwOperation(
                    "signTransactions",
                    "FAIL_WALLET_UNSUPPORTED",
                    MwaOperationException("JUPITER_SIGN_TRANSACTION_UNSUPPORTED", "Jupiter does not support standalone sign_transactions. Use Sign And Send."),
                    authRecordMetadata(record) + transactionsMetadata(transactions),
                )
            }
            val adapter = newAdapter(record.cluster, record)
            AgentMwaLog.info(
                "MwaController",
                "signTransactions",
                "START",
                "opening wallet transaction approval",
                authRecordMetadata(record) + transactionsMetadata(transactions),
            )
            when (val result = adapter.transact(ActivityResultSender(activity)) { _ -> signTransactions(transactions) }) {
                is TransactionResult.Success -> {
                    applyAuthorization(result.authResult, record.cluster, record.walletPackage)
                    val signed = result.payload.signedPayloads?.filterNotNull().orEmpty()
                    if (signed.isEmpty()) {
                        throwOperation(
                            "signTransactions",
                            "FAIL_EMPTY_SIGNED_TRANSACTION",
                            MwaOperationException("EMPTY_SIGNED_TRANSACTION", "Wallet returned no signed transactions."),
                            authRecordMetadata(record) + mapOf("signedPayloadCount" to signed.size),
                        )
                    }
                    signed.map { AgentMwaSigningResult(signature = Base64.encodeToString(it, Base64.NO_WRAP)) }
                        .also {
                            AgentMwaLog.info(
                                "MwaController",
                                "signTransactions",
                                "SUCCESS",
                                "transactions signed",
                                authRecordMetadata(record) + signingResultsMetadata(it) + mapOf("firstSignedBytes" to signed.first().size, "firstSignedSha256_8" to sha256First8(signed.first())),
                            )
                        }
                }
                is TransactionResult.NoWalletFound -> throwNoWallet("signTransactions")
                is TransactionResult.Failure -> throwClassified("signTransactions", "FAIL_WALLET_RESULT", result.e)
            }
        }

    suspend fun signAndSendTransaction(activity: ComponentActivity, transaction: ByteArray, rpcUrl: String? = null): AgentMwaSigningResult =
        signAndSendTransactions(activity, arrayOf(transaction), rpcUrl).first()

    suspend fun signAndSendTransactions(activity: ComponentActivity, transactions: Array<ByteArray>, rpcUrl: String? = null): List<AgentMwaSigningResult> =
        privileged(activity, "signAndSendTransactions") {
            if (transactions.isEmpty() || transactions.any { it.isEmpty() }) {
                throwOperation(
                    "signAndSendTransactions",
                    "FAIL_INVALID_PAYLOADS",
                    MwaOperationException("INVALID_PAYLOADS", "SignAndSendTransactions requires non-empty transaction bytes."),
                    mapOf("count" to transactions.size, "emptyCount" to transactions.count { it.isEmpty() }) + transactionsMetadata(transactions),
                )
            }
            val record = requireActive("signAndSendTransactions")
            val forceSignThenRpc = WalletRegistry.forceSignThenRpc(record.walletPackage)
            val routeNative = !forceSignThenRpc
            val route = if (routeNative) "native_mwa" else "sign_then_rpc"
            AgentMwaLog.info(
                "MwaController",
                "signAndSendTransactions",
                "START",
                "opening wallet sign-and-send approval",
                authRecordMetadata(record) + mapOf("route" to route, "reason" to if (forceSignThenRpc) "backpack_native_unsupported" else "native_default", "requestedRpcUrl" to rpcUrl.orEmpty()) + transactionsMetadata(transactions),
            )
            val adapter = newAdapter(record.cluster, record)
            if (routeNative) {
                signAndSendNative(activity, adapter, record, transactions, rpcUrl)
            } else {
                signThenRpc(activity, adapter, record, transactions, rpcUrl)
            }
        }

    fun capabilitiesJson(): JSONObject {
        val record = requireActive("capabilitiesJson")
        val messageSupported = !WalletRegistry.messageSigningUnsupported(record.walletPackage)
        val standaloneTxSupported = !WalletRegistry.standaloneSignTransactionUnsupported(record.walletPackage)
        val json = JSONObject()
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
        AgentMwaLog.info("MwaController", "capabilitiesJson", "DONE", "capabilities JSON prepared", authRecordMetadata(record) + mapOf("capabilities" to json))
        return json
    }

    suspend fun signBridgeRequest(activity: ComponentActivity, request: AgentMwaBridgeRequest): AgentMwaSigningResult {
        AgentMwaLog.info(
            "MwaController",
            "signBridgeRequest",
            "START",
            "bridge signing request received",
            bridgeRequestMetadata(request),
        )
        val active = requireActive("signBridgeRequest")
        if (request.cluster != active.cluster) {
            throwOperation(
                "signBridgeRequest",
                "FAIL_CLUSTER_MISMATCH",
                MwaOperationException("CLUSTER_MISMATCH", "Bridge request targets ${request.cluster.id}; Android wallet is connected to ${active.cluster.id}."),
                authRecordMetadata(active) + bridgeRequestMetadata(request),
            )
        }
        return when (request.kind) {
            "sign_message" -> {
                val message = decodePayload(request.payloadData, request.payloadEncoding)
                AgentMwaLog.info("MwaController", "signBridgeRequest", "STEP_DECODED_MESSAGE", "bridge message payload decoded", AgentMwaLog.bytesMetadata("message", message, includeUtf8 = true) + bridgeRequestMetadata(request))
                signMessages(activity, arrayOf(message)).first()
            }
            "sign_transaction" -> {
                val transaction = decodePayload(request.payloadData, request.payloadEncoding)
                AgentMwaLog.info("MwaController", "signBridgeRequest", "STEP_DECODED_TRANSACTION", "bridge transaction payload decoded", AgentMwaLog.transactionMetadata("transaction", transaction) + bridgeRequestMetadata(request))
                signTransaction(activity, transaction)
            }
            "sign_and_send_transaction" -> {
                val transaction = decodePayload(request.payloadData, request.payloadEncoding)
                AgentMwaLog.info("MwaController", "signBridgeRequest", "STEP_DECODED_TRANSACTION", "bridge sign-and-send payload decoded", AgentMwaLog.transactionMetadata("transaction", transaction) + bridgeRequestMetadata(request))
                signAndSendTransaction(activity, transaction, request.rpcUrl)
            }
            else -> throwOperation(
                "signBridgeRequest",
                "FAIL_UNSUPPORTED_METHOD",
                MwaOperationException("UNSUPPORTED_METHOD", "Unsupported bridge signing kind: ${request.kind}"),
                authRecordMetadata(active) + bridgeRequestMetadata(request),
            )
        }
    }

    private suspend fun signAndSendNative(
        activity: ComponentActivity,
        adapter: MobileWalletAdapter,
        record: AgentMwaAuthRecord,
        transactions: Array<ByteArray>,
        rpcUrl: String?,
    ): List<AgentMwaSigningResult> {
        val resolvedRpcUrl = resolveRpcUrl(record.cluster, rpcUrl)
        val minContextSlot = fetchLatestContextSlot(record.cluster, resolvedRpcUrl).takeIf { it > 0 }?.toInt()
        val params = TransactionParams(minContextSlot, "confirmed", true, 3, null)
        AgentMwaLog.info(
            "MwaController",
            "signAndSendNative",
            "START",
            "calling native signAndSendTransactions",
            authRecordMetadata(record) + mapOf(
                "minContextSlot" to (minContextSlot ?: ""),
                "commitment" to "confirmed",
                "skipPreflight" to true,
                "maxRetries" to 3,
                "rpc" to resolvedRpcUrl,
            ) + transactionsMetadata(transactions),
        )
        val result = withTimeoutOrNull(SIGN_AND_SEND_TIMEOUT_MS) {
            adapter.transact(ActivityResultSender(activity)) { _ ->
                AgentMwaLog.info(
                    "MwaController",
                    "signAndSendNative",
                    "STEP_MWA_CALL",
                    "calling wallet native sign_and_send_transactions",
                    mapOf("minContextSlot" to (minContextSlot ?: "")) + transactionsMetadata(transactions),
                )
                signAndSendTransactions(transactions, params)
            }
        } ?: throwOperation(
            "signAndSendNative",
            "FAIL_TIMEOUT",
            MwaOperationException("WALLET_HUNG", "Wallet did not reply to sign_and_send_transactions within ${SIGN_AND_SEND_TIMEOUT_MS / 1000}s."),
            authRecordMetadata(record) + mapOf("timeoutMs" to SIGN_AND_SEND_TIMEOUT_MS) + transactionsMetadata(transactions),
        )
        return when (result) {
            is TransactionResult.Success -> {
                applyAuthorization(result.authResult, record.cluster, record.walletPackage)
                val signatures = result.payload.signatures?.filterNotNull().orEmpty()
                if (signatures.isEmpty()) {
                    throwOperation(
                        "signAndSendNative",
                        "FAIL_EMPTY_SIGNATURE",
                        MwaOperationException("EMPTY_SIGNATURE", "Wallet returned no transaction signatures."),
                        authRecordMetadata(record) + mapOf("signatureCount" to signatures.size),
                    )
                }
                signatures.map {
                    val txid = Base58.encode(it)
                    AgentMwaSigningResult(signature = txid, txid = txid)
                }.also {
                    AgentMwaLog.info(
                        "MwaController",
                        "signAndSendTransactions",
                        "SUCCESS",
                        "native sign-and-send complete",
                        authRecordMetadata(record) + signingResultsMetadata(it) + mapOf("minContextSlot" to (minContextSlot ?: "")),
                    )
                }
            }
            is TransactionResult.NoWalletFound -> throwNoWallet("signAndSendNative")
            is TransactionResult.Failure -> throwClassified("signAndSendNative", "FAIL_WALLET_RESULT", result.e)
        }
    }

    private suspend fun signThenRpc(
        activity: ComponentActivity,
        adapter: MobileWalletAdapter,
        record: AgentMwaAuthRecord,
        transactions: Array<ByteArray>,
        rpcUrl: String?,
    ): List<AgentMwaSigningResult> {
        val resolvedRpcUrl = resolveRpcUrl(record.cluster, rpcUrl)
        val balance = getConnectedBalanceLamports(record, resolvedRpcUrl)
        AgentMwaLog.info("MwaController", "signThenRpc", "STEP_BALANCE", "balance checked", authRecordMetadata(record) + mapOf("lamports" to balance, "threshold" to MIN_FEE_PAYER_LAMPORTS, "rpc" to resolvedRpcUrl))
        if (balance in 0 until MIN_FEE_PAYER_LAMPORTS) {
            throwOperation(
                "signThenRpc",
                "FAIL_INSUFFICIENT_FUNDS",
                MwaOperationException("INSUFFICIENT_FUNDS_FOR_RENT", "Connected account has $balance lamports; at least $MIN_FEE_PAYER_LAMPORTS are required before opening the wallet."),
                authRecordMetadata(record) + mapOf("lamports" to balance, "threshold" to MIN_FEE_PAYER_LAMPORTS),
            )
        }
        AgentMwaLog.info(
            "MwaController",
            "signThenRpc",
            "START",
            "calling sign_transactions before RPC broadcast",
            authRecordMetadata(record) + mapOf("rpc" to resolvedRpcUrl) + transactionsMetadata(transactions),
        )
        val result = withTimeoutOrNull(SIGN_AND_SEND_TIMEOUT_MS) {
            adapter.transact(ActivityResultSender(activity)) { _ ->
                AgentMwaLog.info("MwaController", "signThenRpc", "STEP_MWA_CALL", "calling wallet sign_transactions", transactionsMetadata(transactions))
                signTransactions(transactions)
            }
        } ?: throwOperation(
            "signThenRpc",
            "FAIL_TIMEOUT",
            MwaOperationException("WALLET_HUNG", "Wallet did not reply to sign_transactions within ${SIGN_AND_SEND_TIMEOUT_MS / 1000}s."),
            authRecordMetadata(record) + mapOf("timeoutMs" to SIGN_AND_SEND_TIMEOUT_MS) + transactionsMetadata(transactions),
        )
        return when (result) {
            is TransactionResult.Success -> {
                applyAuthorization(result.authResult, record.cluster, record.walletPackage)
                val signed = result.payload.signedPayloads?.filterNotNull().orEmpty()
                if (signed.isEmpty()) {
                    throwOperation(
                        "signThenRpc",
                        "FAIL_EMPTY_SIGNED_TRANSACTION",
                        MwaOperationException("EMPTY_SIGNED_TRANSACTION", "Wallet returned no signed transactions."),
                        authRecordMetadata(record) + mapOf("signedPayloadCount" to signed.size),
                    )
                }
                signed.mapIndexed { index, tx ->
                    val txid = sendSignedTransactionViaRpc(record.cluster, tx, resolvedRpcUrl)
                    AgentMwaLog.info("MwaController", "signThenRpc", "STEP_RPC_SENT", "signed transaction broadcast", mapOf("txIndex" to index, "txid" to txid) + AgentMwaLog.transactionMetadata("signedTransaction", tx))
                    AgentMwaSigningResult(signature = txid, txid = txid)
                }.also {
                    AgentMwaLog.info("MwaController", "signAndSendTransactions", "SUCCESS", "sign-then-rpc complete", authRecordMetadata(record) + signingResultsMetadata(it))
                }
            }
            is TransactionResult.NoWalletFound -> throwNoWallet("signThenRpc")
            is TransactionResult.Failure -> throwClassified("signThenRpc", "FAIL_WALLET_RESULT", result.e)
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
            val previous = requireActive(method)
            AgentMwaLog.warn("MwaController", method, "STEP_AUTH_MISMATCH", "attempting one-shot reauthorization", authRecordMetadata(previous))
            val reauthorized = connect(activity, previous.cluster, previous.walletPackage, forceFresh = true)
            if (reauthorized.publicKeyBase58 != previous.publicKeyBase58) {
                throwOperation(
                    method,
                    "FAIL_WALLET_CHANGED",
                    MwaOperationException("WALLET_CHANGED", "Wallet changed during reauthorization. Reconnect with the intended account."),
                    mapOf("previousPubkey" to previous.publicKeyBase58, "reauthorizedPubkey" to reauthorized.publicKeyBase58),
                )
            }
            block()
        }
    }

    private suspend fun <T> withKeepAlive(method: String, block: suspend () -> T): T {
        startKeepAlive(method)
        return try {
            block()
        } catch (err: Throwable) {
            AgentMwaLog.failure(
                "MwaController",
                method,
                "RESULT_FAIL",
                "operation failed",
                err,
                if (err is MwaOperationException) mapOf("code" to err.code) else emptyMap(),
            )
            throw err
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
        AgentMwaLog.info(
            "MwaController",
            "newAdapter",
            "START",
            "creating mobile wallet adapter",
            authRecordMetadata(record) + mapOf("cluster" to cluster.id, "identityName" to identity.name, "identityUri" to identity.uri, "identityIconUri" to identity.iconUri),
        )
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
        AgentMwaLog.info(
            "MwaController",
            "newAdapter",
            "DONE",
            "mobile wallet adapter prepared",
            authRecordMetadata(record) + mapOf("cluster" to cluster.id, "authRestored" to (record?.authToken?.isNotBlank() == true), "walletUriRestored" to (record?.walletUriBase?.isNotBlank() == true)),
        )
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
        AgentMwaLog.info(
            "MwaController",
            "applyAuthorization",
            "DONE",
            "authorization cached",
            authRecordMetadata(record) + mapOf("publicKeyBytes" to publicKeyBytes.size),
        )
        return record
    }

    private fun requireActive(method: String = "requireActive"): AgentMwaAuthRecord {
        val record = activeRecord
        if (record != null) return record
        throwOperation(
            method,
            "FAIL_NOT_CONNECTED",
            MwaOperationException("UNAUTHORIZED", "No Android MWA wallet is connected."),
            mapOf("cachedCount" to cache.all().size, "latestPubkey" to cache.latest()?.publicKeyBase58.orEmpty()),
        )
    }

    private suspend fun fetchLatestContextSlot(cluster: AgentCluster, rpcUrl: String = cluster.rpcUrl()): Long = try {
        val json = postJsonRpc(rpcUrl, "getLatestBlockhash", """[{"commitment":"confirmed"}]""")
        val slot = json.optJSONObject("result")?.optJSONObject("context")?.optLong("slot", -1L) ?: -1L
        AgentMwaLog.info("MwaController", "fetchLatestContextSlot", "DONE", "context slot fetched", mapOf("slot" to slot, "rpc" to rpcUrl, "cluster" to cluster.id))
        slot
    } catch (err: Exception) {
        AgentMwaLog.warn("MwaController", "fetchLatestContextSlot", "FAIL", "context slot fetch failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        -1L
    }

    private suspend fun getConnectedBalanceLamports(record: AgentMwaAuthRecord, rpcUrl: String = record.cluster.rpcUrl()): Long = try {
        val json = postJsonRpc(rpcUrl, "getBalance", """["${record.publicKeyBase58}",{"commitment":"confirmed"}]""")
        val balance = json.optJSONObject("result")?.optLong("value", -1L) ?: -1L
        AgentMwaLog.info("MwaController", "getConnectedBalanceLamports", "DONE", "balance lookup completed", authRecordMetadata(record) + mapOf("lamports" to balance, "rpc" to rpcUrl))
        balance
    } catch (err: Exception) {
        AgentMwaLog.failure("MwaController", "getConnectedBalanceLamports", "FAIL", "balance lookup failed", err, authRecordMetadata(record))
        -1L
    }

    private suspend fun sendSignedTransactionViaRpc(cluster: AgentCluster, signedTx: ByteArray, rpcUrl: String = cluster.rpcUrl()): String {
        val encoded = Base64.encodeToString(signedTx, Base64.NO_WRAP)
        val params = """["$encoded",{"encoding":"base64","skipPreflight":false,"preflightCommitment":"confirmed","maxRetries":3}]"""
        AgentMwaLog.info(
            "MwaController",
            "sendSignedTransactionViaRpc",
            "START",
            "broadcasting signed transaction by RPC",
            mapOf("cluster" to cluster.id, "rpc" to rpcUrl, "encodedBase64" to if (BuildConfig.DEBUG) encoded else "[debug-only]") + AgentMwaLog.transactionMetadata("signedTransaction", signedTx),
        )
        val json = postJsonRpc(rpcUrl, "sendTransaction", params)
        val error = json.optJSONObject("error")
        if (error != null) {
            throwOperation(
                "sendSignedTransactionViaRpc",
                "FAIL_RPC_ERROR",
                MwaOperationException("RPC_BROADCAST_FAILED", error.optString("message", error.toString())),
                mapOf("cluster" to cluster.id, "rpcError" to error),
            )
        }
        val result = json.optString("result", "")
        if (result.isBlank()) {
            throwOperation(
                "sendSignedTransactionViaRpc",
                "FAIL_EMPTY_RESULT",
                MwaOperationException("RPC_BROADCAST_FAILED", "RPC returned an empty transaction id."),
                mapOf("cluster" to cluster.id, "rpcResponse" to json),
            )
        }
        AgentMwaLog.info("MwaController", "sendSignedTransactionViaRpc", "SUCCESS", "RPC returned transaction id", mapOf("cluster" to cluster.id, "txid" to result, "rpcResponse" to json))
        return result
    }

    private fun resolveRpcUrl(cluster: AgentCluster, requestedRpcUrl: String?): String {
        val trimmed = requestedRpcUrl?.trim().orEmpty()
        if (trimmed.isBlank()) return cluster.rpcUrl()
        val uri = Uri.parse(trimmed)
        val scheme = uri.scheme?.lowercase().orEmpty()
        val host = uri.host.orEmpty()
        val allowed = when (scheme) {
            "https" -> host.isNotBlank()
            "http" -> isLocalOrPrivateHost(host)
            else -> false
        }
        if (!allowed) {
            throw MwaOperationException(
                "INVALID_REQUEST",
                "Android MWA RPC URL must be HTTPS or a trusted local/private HTTP host.",
            )
        }
        AgentMwaLog.info(
            "MwaController",
            "resolveRpcUrl",
            "DONE",
            "RPC URL selected",
            mapOf("cluster" to cluster.id, "rpc" to trimmed, "source" to "bridge_payload"),
        )
        return trimmed
    }

    private fun isLocalOrPrivateHost(host: String): Boolean {
        val normalized = host.trim().lowercase().removePrefix("[").removeSuffix("]").removeSuffix(".")
        if (normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1") return true
        if (normalized.endsWith(".local")) return true
        val parts = normalized.split(".")
        if (parts.size == 4) {
            val octets = parts.map { it.toIntOrNull() }
            if (octets.all { it != null && it >= 0 && it <= 255 }) {
                val first = octets[0] ?: return false
                val second = octets[1] ?: return false
                return first == 10 ||
                    first == 127 ||
                    (first == 172 && second in 16..31) ||
                    (first == 192 && second == 168) ||
                    (first == 169 && second == 254)
            }
        }
        return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")
    }

    private suspend fun postJsonRpc(rpcUrl: String, method: String, paramsJson: String): JSONObject {
        val body = """{"jsonrpc":"2.0","id":1,"method":"$method","params":$paramsJson}"""
        var lastError: Exception? = null
        for (attempt in 1..RPC_MAX_ATTEMPTS) {
            try {
                return postJsonRpcOnce(rpcUrl, method, body, attempt)
            } catch (err: Exception) {
                lastError = err
                val retry = attempt < RPC_MAX_ATTEMPTS && isTransientRpcError(err)
                AgentMwaLog.warn(
                    "MwaController",
                    "postJsonRpc",
                    if (retry) "STEP_RETRY" else "FAIL_EXCEPTION",
                    if (retry) "transient json rpc request failed; retrying" else "json rpc request failed",
                    mapOf(
                        "rpc" to rpcUrl,
                        "method" to method,
                        "attempt" to attempt,
                        "maxAttempts" to RPC_MAX_ATTEMPTS,
                        "retry" to retry,
                    ) + AgentMwaLog.errorMetadata(err),
                )
                if (!retry) throw err
                delay(RPC_RETRY_BASE_DELAY_MS * attempt)
            }
        }
        throw lastError ?: IOException("JSON RPC request failed before an attempt was made.")
    }

    private suspend fun postJsonRpcOnce(rpcUrl: String, method: String, body: String, attempt: Int): JSONObject = withContext(Dispatchers.IO) {
        AgentMwaLog.info(
            "MwaController",
            "postJsonRpc",
            "START",
            "json rpc request starting",
            mapOf(
                "rpc" to rpcUrl,
                "method" to method,
                "attempt" to attempt,
                "body" to if (BuildConfig.DEBUG) body else "[debug-only]",
                "bodyBytes" to body.toByteArray(Charsets.UTF_8).size,
                "bodySha256_8" to sha256First8(body.toByteArray(Charsets.UTF_8)),
            ),
        )
        val conn = (URL(rpcUrl).openConnection() as HttpURLConnection)
        try {
            conn.apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 30_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            AgentMwaLog.info(
                "MwaController",
                "postJsonRpc",
                if (status in 200..299) "SUCCESS" else "FAIL_HTTP_STATUS",
                "json rpc response received",
                mapOf(
                    "rpc" to rpcUrl,
                    "method" to method,
                    "attempt" to attempt,
                    "status" to status,
                    "response" to if (BuildConfig.DEBUG) text else "[debug-only]",
                    "responseBytes" to text.toByteArray(Charsets.UTF_8).size,
                    "responseSha256_8" to sha256First8(text.toByteArray(Charsets.UTF_8)),
                ),
            )
            if (status !in 200..299) {
                throw RpcHttpException(status, text.ifBlank { "HTTP $status from Solana RPC." })
            }
            JSONObject(text)
        } catch (err: Exception) {
            throw err
        } finally {
            conn.disconnect()
        }
    }

    private fun isTransientRpcError(err: Exception): Boolean =
        when (err) {
            is RpcHttpException -> err.isTransient
            is SocketTimeoutException -> true
            is IOException -> true
            else -> false
        }

    private fun decodePayload(data: String, encoding: String): ByteArray {
        AgentMwaLog.info(
            "MwaController",
            "decodePayload",
            "START",
            "decoding bridge payload",
            mapOf("encoding" to encoding, "payloadChars" to data.length, "payloadData" to if (BuildConfig.DEBUG) data else "[debug-only]"),
        )
        return try {
            val decoded = when (encoding) {
                "utf8" -> data.toByteArray(Charsets.UTF_8)
                "base64" -> Base64.decode(data, Base64.DEFAULT)
                else -> throw MwaOperationException("INVALID_PAYLOADS", "Unsupported payload encoding: $encoding")
            }
            AgentMwaLog.info("MwaController", "decodePayload", "SUCCESS", "bridge payload decoded", AgentMwaLog.bytesMetadata("payload", decoded, includeUtf8 = encoding == "utf8"))
            decoded
        } catch (err: MwaOperationException) {
            throwOperation("decodePayload", "FAIL_UNSUPPORTED_ENCODING", err, mapOf("encoding" to encoding, "payloadChars" to data.length))
        } catch (err: IllegalArgumentException) {
            throwOperation(
                "decodePayload",
                "FAIL_DECODE",
                MwaOperationException("INVALID_PAYLOADS", "Failed to decode $encoding payload: ${err.message}", err),
                mapOf("encoding" to encoding, "payloadChars" to data.length, "payloadData" to if (BuildConfig.DEBUG) data else "[debug-only]") + AgentMwaLog.errorMetadata(err),
            )
        }
    }

    private fun authRecordMetadata(record: AgentMwaAuthRecord?): Map<String, Any?> =
        if (record == null) {
            mapOf("connected" to false)
        } else {
            mapOf(
                "connected" to true,
                "pubkey" to record.publicKeyBase58,
                "pubkeyBytes" to record.publicKeyBytes.size,
                "authLen" to record.authToken.length,
                "walletUriBase" to record.walletUriBase,
                "walletPackage" to record.walletPackage,
                "walletType" to record.walletType,
                "accountLabel" to record.accountLabel,
                "cluster" to record.cluster.id,
                "authenticated" to record.authenticated,
                "capabilitiesCsv" to record.capabilitiesCsv,
                "timestampUnixSeconds" to record.timestampUnixSeconds,
            )
        }

    private fun messagesMetadata(messages: Array<ByteArray>): Map<String, Any?> {
        val metadata = mutableMapOf<String, Any?>(
            "messageCount" to messages.size,
            "emptyMessageCount" to messages.count { it.isEmpty() },
        )
        messages.firstOrNull()?.let {
            metadata += AgentMwaLog.bytesMetadata("firstMessage", it, includeUtf8 = true)
        }
        if (BuildConfig.DEBUG) {
            metadata["messages"] = JSONArray().apply {
                messages.forEachIndexed { index, message ->
                    put(
                        JSONObject()
                            .put("index", index)
                            .put("bytes", message.size)
                            .put("sha256_8", sha256First8(message))
                            .put("hex", hexPrefix(message, message.size))
                            .put("utf8", message.toString(Charsets.UTF_8)),
                    )
                }
            }
        }
        return metadata
    }

    private fun transactionsMetadata(transactions: Array<ByteArray>): Map<String, Any?> {
        val metadata = mutableMapOf<String, Any?>(
            "transactionCount" to transactions.size,
            "emptyTransactionCount" to transactions.count { it.isEmpty() },
        )
        transactions.firstOrNull()?.let {
            metadata += AgentMwaLog.transactionMetadata("firstTransaction", it)
            metadata["firstTransactionBase64"] = if (BuildConfig.DEBUG) Base64.encodeToString(it, Base64.NO_WRAP) else "[debug-only]"
        }
        if (BuildConfig.DEBUG) {
            metadata["transactions"] = JSONArray().apply {
                transactions.forEachIndexed { index, tx ->
                    put(
                        JSONObject()
                            .put("index", index)
                            .put("bytes", tx.size)
                            .put("sha256_8", sha256First8(tx))
                            .put("hex", hexPrefix(tx, tx.size))
                            .put("base64", Base64.encodeToString(tx, Base64.NO_WRAP)),
                    )
                }
            }
        }
        return metadata
    }

    private fun signingResultsMetadata(results: List<AgentMwaSigningResult>): Map<String, Any?> {
        val metadata = mutableMapOf<String, Any?>(
            "resultCount" to results.size,
            "firstSignature" to results.firstOrNull()?.signature.orEmpty(),
            "firstTxid" to results.firstOrNull()?.txid.orEmpty(),
        )
        if (BuildConfig.DEBUG) {
            metadata["results"] = JSONArray().apply {
                results.forEachIndexed { index, result ->
                    put(
                        JSONObject()
                            .put("index", index)
                            .put("signature", result.signature)
                            .put("txid", result.txid ?: ""),
                    )
                }
            }
        }
        return metadata
    }

    private fun bridgeRequestMetadata(request: AgentMwaBridgeRequest): Map<String, Any?> =
        mutableMapOf<String, Any?>(
            "requestId" to request.id,
            "kind" to request.kind,
            "cluster" to request.cluster.id,
            "rpcUrl" to request.rpcUrl.orEmpty(),
            "summary" to request.summary.orEmpty(),
            "payloadEncoding" to request.payloadEncoding,
            "payloadChars" to request.payloadData.length,
            "payloadSha256_8" to sha256First8(request.payloadData.toByteArray(Charsets.UTF_8)),
        ).apply {
            if (BuildConfig.DEBUG) {
                put("payloadData", request.payloadData)
            }
        }

    private fun describeTransaction(tx: ByteArray): String =
        "tx_bytes=${tx.size} sha256_8=${sha256First8(tx)} first12=${hexPrefix(tx, 12)}"

    private fun sha256First8(bytes: ByteArray): String = hexPrefix(MessageDigest.getInstance("SHA-256").digest(bytes), 8)

    private fun hexPrefix(bytes: ByteArray, count: Int): String =
        bytes.take(count).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun short(value: String, head: Int = 8, tail: Int = 8): String =
        if (value.length <= head + tail + 3) value else "${value.take(head)}...${value.takeLast(tail)}"

    private fun throwNoWallet(method: String): Nothing =
        throwOperation(
            method,
            "FAIL_NO_WALLET_FOUND",
            MwaOperationException("NO_WALLET_FOUND", "No MWA-compatible wallet was found."),
        )

    private fun throwClassified(method: String, step: String, err: Throwable?): Nothing =
        throwOperation(method, step, classifyFailure(err), AgentMwaLog.errorMetadata(err))

    private fun throwOperation(
        method: String,
        step: String,
        err: MwaOperationException,
        metadata: Map<String, Any?> = emptyMap(),
    ): Nothing {
        AgentMwaLog.warn(
            "MwaController",
            method,
            step,
            "operation failed",
            metadata + mapOf("code" to err.code, "message" to err.message),
        )
        throw err
    }

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
        private const val SIGN_MESSAGES_TIMEOUT_MS = 60_000L
        private const val SIGN_AND_SEND_TIMEOUT_MS = 120_000L
        private const val MIN_FEE_PAYER_LAMPORTS = 1_000_000L
        private const val RPC_MAX_ATTEMPTS = 3
        private const val RPC_RETRY_BASE_DELAY_MS = 350L
    }
}

private class RpcHttpException(
    val status: Int,
    message: String,
) : IOException(message) {
    val isTransient: Boolean = status == 408 || status == 425 || status == 429 || status in 500..599
}

class MwaOperationException(
    val code: String,
    override val message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
