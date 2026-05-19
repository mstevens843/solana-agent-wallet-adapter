package com.agentic.wallet.mwa

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Base64
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
        val restoredPackage = restoredWalletPackage(latest)
        activeRecord = latest.copy(
            cluster = cluster,
            authenticated = true,
            walletPackage = restoredPackage,
            walletType = if (restoredPackage == latest.walletPackage) latest.walletType else WalletRegistry.walletType(restoredPackage, latest.walletUriBase),
        )
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
        val restoredPackage = restoredWalletPackage(record)
        activeRecord = record.copy(
            cluster = cluster,
            authenticated = true,
            walletPackage = restoredPackage,
            walletType = if (restoredPackage == record.walletPackage) record.walletType else WalletRegistry.walletType(restoredPackage, record.walletUriBase),
        )
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

    suspend fun deauthorizeRemote(sender: ActivityResultSender, reason: String) = withKeepAlive("deauthorizeRemote") {
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
            when (val result = adapter.disconnect(sender)) {
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
        sender: ActivityResultSender,
        cluster: AgentCluster,
        targetWalletPackage: String = "",
        forceFresh: Boolean = true,
    ): AgentMwaAuthRecord = withKeepAlive("connect") {
        cache.clearBlacklist()
        // Parity with grant-godot PR #449 (clearState fix): expose FRESH vs CACHED in logs so
        // the rare "silent reuse" case (used auth token instead of opening OS picker) is observable.
        val cachedReference = if (forceFresh) null else activeRecord
        val path = if (cachedReference == null) "FRESH" else "CACHED"
        AgentMwaLog.info(
            "MwaController",
            "connect",
            "START",
            "opening wallet authorization",
            mapOf(
                "cluster" to cluster.id,
                "targetWalletPackage" to targetWalletPackage,
                "forceFresh" to forceFresh,
                "path" to path,
                "hadActiveRecord" to (activeRecord != null),
                "cachedAuthToken" to (cachedReference?.authToken?.isNotBlank() == true),
            ),
        )
        val adapter = newAdapter(cluster, cachedReference)
        when (val result = adapter.connect(sender)) {
            is TransactionResult.Success -> {
                val record = applyAuthorization(result.authResult, cluster, targetWalletPackage)
                AgentMwaLog.info(
                    "MwaController",
                    "connect",
                    "SUCCESS",
                    "wallet authorized",
                    authRecordMetadata(record) + mapOf("path" to path),
                )
                record
            }
            is TransactionResult.NoWalletFound -> throwNoWallet("connect")
            is TransactionResult.Failure -> throwClassified("connect", "FAIL_WALLET_RESULT", result.e)
        }
    }

    suspend fun connectWithSignIn(
        sender: ActivityResultSender,
        cluster: AgentCluster,
        domain: String,
        statement: String,
    ): AgentMwaSignInResult = withKeepAlive("connectWithSignIn") {
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
                // Parity with grant-godot PR #453 and Unity PR #SIWS:
                // Prefer the wallet's native sign_in_result. If the wallet doesn't return
                // one (Jupiter etc.), the Kotlin clientlib falls back to sign_messages
                // with a CAIP-122 message and constructs SignInResult from the response.
                // Wallets that fail `sign_messages` over MWA (Solflare, Seed Vault — see
                // [WalletRegistry.supportsSiws]) are short-circuited above so they never
                // reach this fallback; callers must use plain [connect] + [signProofMessage]
                // (memo-tx) for those wallets.
                val nativeSignIn = result.authResult.signInResult
                val signIn = nativeSignIn ?: result.payload
                val path = if (nativeSignIn != null) "native" else "fallback"
                val account = result.authResult.accounts?.firstOrNull()
                val signInResult = AgentMwaSignInResult(
                    signature = Base58.encode(signIn.signature),
                    signedMessage = Base64.encodeToString(signIn.signedMessage, Base64.NO_WRAP),
                    publicKeyBase58 = applied.publicKeyBase58,
                    accountLabel = applied.accountLabel,
                    chains = account?.chains?.toList().orEmpty(),
                    features = account?.features?.toList().orEmpty(),
                    authToken = applied.authToken,
                    walletPackage = applied.walletPackage,
                    cluster = applied.cluster.id,
                    path = path,
                )
                AgentMwaLog.info(
                    "MwaController",
                    "connectWithSignIn",
                    "SUCCESS",
                    "wallet signed SIWS payload",
                    authRecordMetadata(applied) +
                        AgentMwaLog.bytesMetadata("signedMessage", signIn.signedMessage, includeUtf8 = true) +
                        mapOf(
                            "signature" to signInResult.signature,
                            "path" to path,
                            "chains" to signInResult.chains.joinToString(","),
                            "features" to signInResult.features.joinToString(","),
                        ),
                )
                signInResult
            }
            is TransactionResult.NoWalletFound -> throwNoWallet("connectWithSignIn")
            is TransactionResult.Failure -> throwClassified("connectWithSignIn", "FAIL_WALLET_RESULT", result.e)
        }
    }

    /**
     * Returns the active MWA auth token, or empty string when no session is live.
     * Parity with grant-godot PR #449 getAuthToken and Unity PR AuthToken getter —
     * lets the web side surface the token in dev tabs or hand it off across boundaries.
     */
    fun getAuthToken(): String = activeRecord?.authToken
        ?: cache.latest()?.authToken
        ?: ""

    /**
     * Restores an MWA auth record (pubkey + token + walletPackage + cluster) into the
     * encrypted AuthCache so future sign operations reuse it without re-prompting.
     * Parity with grant-godot PR #449 setAuthToken — lets the JS layer hydrate the
     * Kotlin cache from cloud workspace backup or hand-off from another surface.
     *
     * Pass blank [token] to clear the cached token without nuking the record.
     */
    fun setAuthToken(
        token: String,
        publicKeyBase58: String,
        walletPackage: String = "",
        cluster: AgentCluster = AgentCluster.MainnetBeta,
    ): AgentMwaAuthRecord? {
        if (publicKeyBase58.isBlank()) {
            AgentMwaLog.warn(
                "MwaController",
                "setAuthToken",
                "FAIL_INVALID",
                "publicKeyBase58 is required",
                mapOf("tokenLen" to token.length),
            )
            return null
        }
        val existing = cache.get(publicKeyBase58)
        val publicKeyBytes = existing?.publicKeyBytes?.takeIf { it.isNotEmpty() }
            ?: runCatching { Base58.decode(publicKeyBase58) }.getOrElse { ByteArray(0) }
        if (publicKeyBytes.isEmpty()) {
            AgentMwaLog.warn(
                "MwaController",
                "setAuthToken",
                "FAIL_INVALID_PUBKEY",
                "publicKeyBase58 could not be decoded",
                mapOf("publicKey" to publicKeyBase58),
            )
            return null
        }
        val record = (existing ?: AgentMwaAuthRecord(publicKeyBase58 = publicKeyBase58)).copy(
            publicKeyBase58 = publicKeyBase58,
            publicKeyBytes = publicKeyBytes,
            authToken = token,
            walletPackage = walletPackage.ifBlank { existing?.walletPackage.orEmpty() },
            walletType = WalletRegistry.walletType(
                walletPackage.ifBlank { existing?.walletPackage.orEmpty() },
                existing?.walletUriBase.orEmpty(),
            ),
            cluster = cluster,
            timestampUnixSeconds = System.currentTimeMillis() / 1000L,
            authenticated = token.isNotBlank(),
        )
        cache.set(record)
        activeRecord = if (token.isBlank()) null else record
        AgentMwaLog.info(
            "MwaController",
            "setAuthToken",
            "DONE",
            "auth token injected from external cache",
            authRecordMetadata(record) + mapOf("tokenLen" to token.length, "cleared" to token.isBlank()),
        )
        return record
    }

    suspend fun getCapabilities(sender: ActivityResultSender): String = privileged(sender, "getCapabilities") {
        val record = requireActive("getCapabilities")
        val adapter = newAdapter(record.cluster, record)
        AgentMwaLog.info("MwaController", "getCapabilities", "START", "opening wallet get_capabilities request", authRecordMetadata(record))
        when (val result = adapter.transact(sender) { _ -> getCapabilities() }) {
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

    suspend fun signMessage(sender: ActivityResultSender, message: String, rpcUrl: String? = null): AgentMwaSigningResult =
        signMessages(sender, arrayOf(message.toByteArray(Charsets.UTF_8)), rpcUrl).first()

    suspend fun signMessages(sender: ActivityResultSender, messages: Array<ByteArray>, rpcUrl: String? = null): List<AgentMwaSigningResult> =
        privileged(sender, "signMessages") {
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
                // Phantom and Solflare advertise no `solana:signMessages` feature in their
                // MWA `get_capabilities` reply (see grant-godot/KNOWN_ISSUES.md). Seed
                // Vault on Seeker hardware advertises sign_messages but the Seed
                // Management UI surfaces only a Close button when invoked through that
                // path — failure observed on real-device testing; not captured by the
                // reference apps because they don't exercise sign_messages with Seed
                // Vault. The browser-side ownership-proof helper
                // (`apps/browser-demo/src/walletProofSigning.ts`) and the native bridge's
                // [signProofMessage] both substitute a memo-only `sign_transactions` call
                // for all three wallets. Any caller reaching this branch bypassed those
                // helpers, so we fail fast with an actionable error rather than silently
                // building a tx that the unaware caller won't know how to forward to the
                // server verifier.
                throwOperation(
                    "signMessages",
                    "FAIL_WALLET_UNSUPPORTED",
                    MwaOperationException("WALLET_SIGN_MESSAGES_UNSUPPORTED", "This wallet does not implement sign_messages over Android MWA. Use the walletProofSigning helper which falls back to a memo-only sign_transactions call."),
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
                adapter.transact(sender) { _ ->
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

    suspend fun signTransaction(sender: ActivityResultSender, transaction: ByteArray): AgentMwaSigningResult =
        signTransactions(sender, arrayOf(transaction)).first()

    suspend fun signTransactions(sender: ActivityResultSender, transactions: Array<ByteArray>): List<AgentMwaSigningResult> =
        privileged(sender, "signTransactions") {
            if (transactions.isEmpty() || transactions.any { it.isEmpty() }) {
                throwOperation(
                    "signTransactions",
                    "FAIL_INVALID_PAYLOADS",
                    MwaOperationException("INVALID_PAYLOADS", "SignTransactions requires non-empty transaction bytes."),
                    mapOf("count" to transactions.size, "emptyCount" to transactions.count { it.isEmpty() }) + transactionsMetadata(transactions),
                )
            }
            val record = requireActive("signTransactions")
            val adapter = newAdapter(record.cluster, record)
            AgentMwaLog.info(
                "MwaController",
                "signTransactions",
                "START",
                "opening wallet transaction approval",
                authRecordMetadata(record) + transactionsMetadata(transactions),
            )
            when (val result = adapter.transact(sender) { _ -> signTransactions(transactions) }) {
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

    /**
     * Ownership-proof signing path. For wallets that implement `sign_messages` over MWA
     * (Backpack, Jupiter, ...) this delegates straight to [signMessage]. For wallets
     * whose `sign_messages` either advertises false (Phantom, Solflare) or hangs with a
     * Close-only approval sheet returning `CancellationException` (Seed Vault on Seeker
     * hardware), this builds a memo-only legacy transaction whose memo data is the same
     * UTF-8 proof bytes, signs it via `sign_transactions`, and returns the ed25519
     * signature together with the full signed transaction (base64). The transaction is
     * never broadcast; the server-side `verifyTxMemoProof` extracts the memo and
     * ed25519-verifies the signature over the compiled message bytes.
     *
     * Routing decision and byte-layout helpers live in [MemoProofRouter]; see
     * `apps/android-twa/app/src/main/java/com/agentic/wallet/mwa/MemoProofTx.kt` for the
     * wire-format invariants (account-key order in particular).
     */
    suspend fun signProofMessage(sender: ActivityResultSender, message: String, rpcUrl: String? = null): AgentMwaSigningResult {
        if (message.isEmpty()) {
            throwOperation(
                "signProofMessage",
                "FAIL_INVALID_PAYLOADS",
                MwaOperationException("INVALID_PAYLOADS", "signProofMessage requires a non-empty message."),
                mapOf("messageChars" to message.length),
            )
        }
        val record = requireActive("signProofMessage")
        if (!MemoProofRouter.useMemoTxFallback(record.walletPackage)) {
            AgentMwaLog.info(
                "MwaController",
                "signProofMessage",
                "STEP_ROUTE_SIGN_MESSAGE",
                "wallet supports sign_messages; delegating",
                authRecordMetadata(record) + mapOf("messageChars" to message.length),
            )
            return signMessage(sender, message, rpcUrl)
        }
        val resolvedRpcUrl = resolveRpcUrl(record.cluster, rpcUrl)
        val blockhashBytes = fetchLatestBlockhashBytes(resolvedRpcUrl)
        val memoBytes = message.toByteArray(Charsets.UTF_8)
        val unsignedTx = try {
            MemoProofRouter.buildUnsignedMemoTx(record.publicKeyBytes, blockhashBytes, message)
        } catch (err: IllegalArgumentException) {
            throwOperation(
                "signProofMessage",
                "FAIL_BUILD_MEMO_TX",
                MwaOperationException("INVALID_PAYLOADS", "Failed to build memo proof transaction: ${err.message}", err),
                authRecordMetadata(record) + mapOf("memoLen" to memoBytes.size, "feePayerLen" to record.publicKeyBytes.size, "blockhashLen" to blockhashBytes.size),
            )
        }
        AgentMwaLog.info(
            "MwaController",
            "signProofMessage",
            "STEP_MEMO_TX_BUILT",
            "memo-tx built; opening wallet sign_transactions",
            authRecordMetadata(record) + mapOf(
                "rpc" to resolvedRpcUrl,
                "blockhashBase58Head" to Base58.encode(blockhashBytes).take(8),
                "memoBytes" to memoBytes.size,
                "memoSha256_8" to sha256First8(memoBytes),
                "txBytes" to unsignedTx.size,
            ),
        )
        val signed = signTransactions(sender, arrayOf(unsignedTx)).first()
        val signedTxBytes = try {
            Base64.decode(signed.signature, Base64.DEFAULT)
        } catch (err: IllegalArgumentException) {
            throwOperation(
                "signProofMessage",
                "FAIL_DECODE_SIGNED_TX",
                MwaOperationException("EMPTY_SIGNATURE", "Wallet returned a signed transaction that is not valid base64.", err),
                authRecordMetadata(record),
            )
        }
        val result = try {
            MemoProofRouter.resultFromSignedTx(signed.signature, signedTxBytes)
        } catch (err: IllegalArgumentException) {
            throwOperation(
                "signProofMessage",
                "FAIL_EXTRACT_SIGNATURE",
                MwaOperationException("EMPTY_SIGNATURE", "Wallet returned a signed transaction with no extractable signature.", err),
                authRecordMetadata(record) + mapOf("signedTxBytes" to signedTxBytes.size),
            )
        }
        AgentMwaLog.info(
            "MwaController",
            "signProofMessage",
            "SUCCESS",
            "memo-tx proof signed",
            authRecordMetadata(record) + mapOf(
                "signatureBase58" to result.signature,
                "transactionBytes" to signedTxBytes.size,
                "transactionSha256_8" to sha256First8(signedTxBytes),
            ),
        )
        return result
    }

    suspend fun signAndSendTransaction(sender: ActivityResultSender, transaction: ByteArray, rpcUrl: String? = null): AgentMwaSigningResult =
        signAndSendTransactions(sender, arrayOf(transaction), rpcUrl).first()

    suspend fun signAndSendTransactions(sender: ActivityResultSender, transactions: Array<ByteArray>, rpcUrl: String? = null): List<AgentMwaSigningResult> =
        privileged(sender, "signAndSendTransactions") {
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
            val routeReason = when {
                !forceSignThenRpc -> "native_default"
                record.walletPackage.lowercase().contains("backpack") -> "backpack_native_unsupported"
                record.walletPackage.lowercase().let { it.contains("jupiter") || it.contains("jup") } -> "jupiter_forced_sign_then_rpc"
                else -> "forced_sign_then_rpc"
            }
            val firstTxVersion = transactions.firstOrNull()?.firstOrNull()?.let { byte ->
                if (byte.toInt() and 0x80 != 0) "v${byte.toInt() and 0x7f}" else "legacy"
            } ?: "empty"
            AgentMwaLog.info(
                "MwaController",
                "signAndSendTransactions",
                "START",
                "opening wallet sign-and-send approval",
                authRecordMetadata(record) + mapOf("route" to route, "reason" to routeReason, "requestedRpcUrl" to rpcUrl.orEmpty(), "firstTxVersion" to firstTxVersion) + transactionsMetadata(transactions),
            )
            val adapter = newAdapter(record.cluster, record)
            if (routeNative) {
                signAndSendNative(sender, adapter, record, transactions, rpcUrl)
            } else {
                signThenRpc(sender, adapter, record, transactions, rpcUrl)
            }
        }

    fun capabilitiesJson(): JSONObject {
        val record = requireActive("capabilitiesJson")
        val messageSupported = !WalletRegistry.messageSigningUnsupported(record.walletPackage)
        val json = JSONObject()
            .put("backend", "android-native-mwa")
            .put("cluster", JSONArray().put(record.cluster.id))
            .put(
                "supports",
                JSONObject()
                    .put("signMessage", messageSupported)
                    .put("signTransaction", true)
                    .put("signAndSendTransaction", true)
                    .put("multiSign", true)
                    .put("simulationPreview", false),
            )
            .put("address", record.publicKeyBase58)
        AgentMwaLog.info("MwaController", "capabilitiesJson", "DONE", "capabilities JSON prepared", authRecordMetadata(record) + mapOf("capabilities" to json))
        return json
    }

    suspend fun signBridgeRequest(sender: ActivityResultSender, request: AgentMwaBridgeRequest): AgentMwaSigningResult {
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
                signMessages(sender, arrayOf(message), request.rpcUrl).first()
            }
            "sign_transaction" -> {
                val transaction = decodePayload(request.payloadData, request.payloadEncoding)
                AgentMwaLog.info("MwaController", "signBridgeRequest", "STEP_DECODED_TRANSACTION", "bridge transaction payload decoded", AgentMwaLog.transactionMetadata("transaction", transaction) + bridgeRequestMetadata(request))
                signTransaction(sender, transaction)
            }
            "sign_proof" -> {
                // Routes through [signProofMessage] which dispatches per wallet capability:
                // sign-messages-capable wallets sign the UTF-8 bytes directly; Phantom/Solflare
                // get a memo-tx fallback. The dApp passes the proof bytes the same way as
                // sign_message; native owns the routing so JS doesn't need wallet detection.
                val message = decodePayload(request.payloadData, request.payloadEncoding).toString(Charsets.UTF_8)
                AgentMwaLog.info("MwaController", "signBridgeRequest", "STEP_DECODED_PROOF", "bridge proof payload decoded", mapOf("messageChars" to message.length) + bridgeRequestMetadata(request))
                signProofMessage(sender, message, request.rpcUrl)
            }
            "sign_and_send_transaction" -> {
                val transaction = decodePayload(request.payloadData, request.payloadEncoding)
                AgentMwaLog.info("MwaController", "signBridgeRequest", "STEP_DECODED_TRANSACTION", "bridge sign-and-send payload decoded", AgentMwaLog.transactionMetadata("transaction", transaction) + bridgeRequestMetadata(request))
                signAndSendTransaction(sender, transaction, request.rpcUrl)
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
        sender: ActivityResultSender,
        adapter: MobileWalletAdapter,
        record: AgentMwaAuthRecord,
        transactions: Array<ByteArray>,
        rpcUrl: String?,
    ): List<AgentMwaSigningResult> {
        val resolvedRpcUrl = resolveRpcUrl(record.cluster, rpcUrl)
        // Parity with grant-godot KNOWN_ISSUES rent fix (lines 444-484): even native sign_and_send
        // can fail at the validator with InsufficientFundsForRent — wallets like Seed Vault inject
        // ComputeBudget priority-fee ix before signing, pushing the required balance higher than
        // a naive caller would assume. Pre-check here so the wallet sheet never opens when the
        // account is under-funded.
        val balance = getConnectedBalanceLamports(record, resolvedRpcUrl)
        AgentMwaLog.info(
            "MwaController",
            "signAndSendNative",
            "STEP_BALANCE",
            "balance checked",
            authRecordMetadata(record) + mapOf("lamports" to balance, "threshold" to MIN_FEE_PAYER_LAMPORTS, "rpc" to resolvedRpcUrl),
        )
        if (balance in 0 until MIN_FEE_PAYER_LAMPORTS) {
            throwOperation(
                "signAndSendNative",
                "FAIL_INSUFFICIENT_FUNDS",
                MwaOperationException(
                    "INSUFFICIENT_FUNDS_FOR_RENT",
                    "Connected account has $balance lamports; at least $MIN_FEE_PAYER_LAMPORTS are required before opening the wallet.",
                ),
                authRecordMetadata(record) + mapOf("lamports" to balance, "threshold" to MIN_FEE_PAYER_LAMPORTS),
            )
        }
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
            adapter.transact(sender) { _ ->
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
        sender: ActivityResultSender,
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
            adapter.transact(sender) { _ ->
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
        sender: ActivityResultSender,
        method: String,
        block: suspend () -> T,
    ): T = withKeepAlive(method) {
        try {
            block()
        } catch (err: MwaOperationException) {
            if (err.code != "WALLET_AUTH_MISMATCH") throw err
            val previous = requireActive(method)
            AgentMwaLog.warn("MwaController", method, "STEP_AUTH_MISMATCH", "attempting one-shot reauthorization", authRecordMetadata(previous))
            val reauthorized = connect(sender, previous.cluster, previous.walletPackage, forceFresh = true)
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
        // MWA spec requires iconRelativeUri to be RELATIVE to identityUri. If a caller
        // (or older cached config) hands us an absolute URI, strip it back to the path
        // segment so ConnectionIdentity doesn't throw "iconRelativeUri must be a relative uri".
        val iconUri = relativeIconUri(identity.iconUri, identity.uri)
        AgentMwaLog.info(
            "MwaController",
            "newAdapter",
            "START",
            "creating mobile wallet adapter",
            authRecordMetadata(record) + mapOf(
                "cluster" to cluster.id,
                "identityName" to identity.name,
                "identityUri" to identity.uri,
                "identityIconUri" to identity.iconUri,
                "iconRelative" to iconUri,
            ),
        )
        val adapter = MobileWalletAdapter(
            ConnectionIdentity(
                Uri.parse(identity.uri),
                Uri.parse(iconUri ?: "favicon.ico"),
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

    /**
     * Coerces [raw] into a relative URI suitable for MWA `iconRelativeUri`.
     *
     * Per the MWA spec, `iconRelativeUri` must be a relative URI resolved against
     * the identity base. The Kotlin clientlib's `ConnectionIdentity` constructor
     * enforces this with `require(iconUri == null || !iconUri.isAbsolute) { "if non-null, iconRelativeUri must be a relative uri" }`.
     *
     * If [raw] is blank → return null (no icon).
     * If [raw] is absolute and starts with [identityBase] → return the path after the base.
     * If [raw] is absolute on a different origin → drop the origin, keep the path.
     * Otherwise it's already relative → return as-is.
     */
    private fun relativeIconUri(raw: String, identityBase: String): String? {
        if (raw.isBlank()) return null
        val parsed = runCatching { Uri.parse(raw) }.getOrNull() ?: return null
        if (!parsed.isAbsolute) return raw.trimStart('/').ifBlank { null }
        // Absolute URI — strip down to the path-and-after.
        val baseUri = runCatching { Uri.parse(identityBase) }.getOrNull()
        val sameOrigin = baseUri != null && parsed.scheme == baseUri.scheme && parsed.host == baseUri.host && parsed.port == baseUri.port
        val rel = buildString {
            append(parsed.path.orEmpty().trimStart('/'))
            parsed.encodedQuery?.takeIf { it.isNotEmpty() }?.let { append('?').append(it) }
            parsed.encodedFragment?.takeIf { it.isNotEmpty() }?.let { append('#').append(it) }
        }
        if (!sameOrigin) {
            AgentMwaLog.warn(
                "MwaController",
                "relativeIconUri",
                "WARN_CROSS_ORIGIN_ICON",
                "iconUri origin differs from identity origin; coerced to relative path",
                mapOf("iconUri" to raw, "identityBase" to identityBase, "relative" to rel),
            )
        }
        return rel.ifBlank { null }
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

    // Defensive: cached records from older builds (or ones authorized by a wallet that
    // didn't return walletUriBase at the time) can have a blank walletPackage. All the
    // wallet-routing checks (messageSigningUnsupported, forceSignThenRpc, supportsSiws)
    // key off this field, so a blank value silently sends Solflare/Jupiter requests
    // down the wrong path. Re-derive from walletUriBase whenever the cached package
    // is empty.
    private fun restoredWalletPackage(record: AgentMwaAuthRecord): String {
        if (record.walletPackage.isNotBlank()) return record.walletPackage
        val inferred = WalletRegistry.inferPackage(record.walletUriBase)
        if (inferred.isNotBlank()) {
            AgentMwaLog.info(
                "MwaController",
                "restoredWalletPackage",
                "DONE",
                "wallet package re-derived from walletUriBase on reconnect",
                mapOf("pubkey" to record.publicKeyBase58, "walletUriBase" to record.walletUriBase, "inferred" to inferred),
            )
        }
        return inferred
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

    /**
     * Returns a 32-byte recent blockhash for use in the never-broadcast memo proof tx.
     * Falls back to a zero blockhash on any RPC failure — proof signing must never block
     * on RPC because the transaction is never sent and the server-side verifier does
     * not validate blockhash freshness (only memo content + ed25519 signature).
     */
    private suspend fun fetchLatestBlockhashBytes(rpcUrl: String): ByteArray = try {
        val json = postJsonRpc(rpcUrl, "getLatestBlockhash", """[{"commitment":"confirmed"}]""")
        val blockhashBase58 = json.optJSONObject("result")?.optJSONObject("value")?.optString("blockhash", "").orEmpty()
        if (blockhashBase58.isBlank()) {
            AgentMwaLog.warn("MwaController", "fetchLatestBlockhashBytes", "FAIL_EMPTY", "RPC returned no blockhash; using zero placeholder", mapOf("rpc" to rpcUrl, "response" to json))
            ByteArray(32)
        } else {
            val bytes = Base58.decode(blockhashBase58)
            if (bytes.size == 32) {
                AgentMwaLog.info("MwaController", "fetchLatestBlockhashBytes", "DONE", "blockhash fetched", mapOf("rpc" to rpcUrl, "blockhashBase58Head" to blockhashBase58.take(8)))
                bytes
            } else {
                AgentMwaLog.warn("MwaController", "fetchLatestBlockhashBytes", "FAIL_DECODE", "blockhash did not decode to 32 bytes; using zero placeholder", mapOf("rpc" to rpcUrl, "decodedLen" to bytes.size, "blockhashBase58" to blockhashBase58))
                ByteArray(32)
            }
        }
    } catch (err: Exception) {
        AgentMwaLog.warn("MwaController", "fetchLatestBlockhashBytes", "FAIL", "blockhash fetch failed; using zero placeholder", mapOf("rpc" to rpcUrl, "class" to err.javaClass.simpleName, "message" to err.message))
        ByteArray(32)
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
        val cls = err?.javaClass?.simpleName.orEmpty()
        val causeCls = err?.cause?.javaClass?.simpleName.orEmpty()
        // Cocos parity (KNOWN_ISSUES #6): Solflare/Flutter wallets throw ExecutionException with
        // a null cause and blank message when the wallet crashes mid-call (e.g. on sign_messages or
        // sign_and_deauthorize). Surface a distinct WALLET_CRASHED so the UI can prompt the user
        // to retry with a different wallet instead of "wallet error".
        val crashed = cls == "ExecutionException" && err?.cause == null && message.isBlank()
        val code = when {
            crashed -> "WALLET_CRASHED"
            cls == "CancellationException" && message.isBlank() -> "WALLET_CRASHED"
            lower.contains("auth_token") || lower.contains("auth token") || lower.contains("not authorized") || lower.contains("reauthorize") -> "WALLET_AUTH_MISMATCH"
            lower.contains("user rejected") || lower.contains("declined") || lower.contains("cancelled") || lower.contains("canceled") -> "USER_REJECTED"
            lower.contains("timeout") || lower.contains("timed out") -> "WALLET_HUNG"
            lower.contains("jsondecodingexception") || lower.contains("class discriminator") || causeCls.contains("JsonDecodingException") -> "WALLET_NATIVE_SIGN_AND_SEND_UNSUPPORTED"
            lower.contains("insufficientfundsforrent") || lower.contains("insufficient funds for rent") -> "INSUFFICIENT_FUNDS_FOR_RENT"
            lower.contains("mincontextslot") -> "PHANTOM_REQUIRES_MIN_CONTEXT_SLOT"
            lower.contains("invalid") || lower.contains("payload") -> "INVALID_PAYLOADS"
            else -> "WALLET_ERROR"
        }
        val resolvedMessage = when {
            crashed -> "Wallet crashed mid-request. Try another wallet (Backpack, Phantom, or Jupiter)."
            message.isNotBlank() -> message
            err != null -> "${err.javaClass.simpleName} (no message)"
            else -> "Wallet operation failed."
        }
        return MwaOperationException(code, resolvedMessage, err)
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
