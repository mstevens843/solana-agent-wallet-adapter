package com.agentic.wallet.streaming

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.agentic.wallet.mwa.AgentMwaLog
import com.agentic.wallet.mwa.Base58
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.math.RoundingMode
import java.security.SecureRandom
import java.security.KeyStore
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Arrays
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class StreamingSessionController(context: Context) {
    private val appContext = context.applicationContext
    private val prefs: SharedPreferences = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun prepareSessionSigner(metadata: JSONObject = JSONObject()): JSONObject {
        val signerId = newSignerId()
        val seed = ByteArray(ED25519_SEED_BYTES)
        val publicKey: ByteArray
        val secret: ByteArray
        SecureRandom().nextBytes(seed)
        try {
            val privateKey = Ed25519PrivateKeyParameters(seed, 0)
            publicKey = privateKey.generatePublicKey().encoded
            secret = seed + publicKey
        } catch (err: Exception) {
            Arrays.fill(seed, 0)
            throw err
        }
        try {
            val alias = aliasFor("signer:$signerId")
            deleteKeyAlias(alias)
            val encrypted = encryptSecret(alias, signerId, secret)
            val now = System.currentTimeMillis()
            val publicKeyBase58 = Base58.encode(publicKey)
            val record = JSONObject()
                .put("schema", LOCAL_SIGNER_SCHEMA)
                .put("signerId", signerId)
                .put("status", "prepared")
                .put("keyAlias", alias)
                .put("keyAad", signerId)
                .put("iv", encrypted.ivBase64)
                .put("ciphertext", encrypted.ciphertextBase64)
                .put("ephemeralSignerPubkey", publicKeyBase58)
                .put("signerRuntime", SIGNER_RUNTIME_ANDROID)
                .put("createdAtMs", now)
                .put("updatedAtMs", now)
            copyOptionalString(metadata, record, "tokenSymbol")
            copyOptionalInt(metadata, record, "tokenDecimals")
            prefs.edit().putString(signerPrefKey(signerId), record.toString()).apply()
            AgentMwaLog.info(
                "StreamingSessionController",
                "prepareSessionSigner",
                "DONE",
                "native streaming signer prepared",
                mapOf("signerId" to signerId, "ephemeralSignerPubkey" to publicKeyBase58),
            )
            return JSONObject()
                .put("signerId", signerId)
                .put("ephemeralSignerPubkey", publicKeyBase58)
                .put("signerRuntime", SIGNER_RUNTIME_ANDROID)
                .put("activeSessions", activeSessionCountLocked())
        } finally {
            Arrays.fill(seed, 0)
            Arrays.fill(secret, 0)
        }
    }

    @Synchronized
    fun createSession(
        sessionId: String,
        ephemeralPrivkeyBase64: String,
        metadata: JSONObject = JSONObject(),
    ): JSONObject {
        val cleanSessionId = requireSessionId(sessionId)
        val secret = decodeSecret(ephemeralPrivkeyBase64)
        var seed = ByteArray(0)
        try {
            seed = secret.copyOfRange(0, ED25519_SEED_BYTES)
            val privateKey = Ed25519PrivateKeyParameters(seed, 0)
            val publicKey = privateKey.generatePublicKey().encoded
            val embeddedPublicKey = secret.copyOfRange(ED25519_SEED_BYTES, ED25519_SECRET_KEY_BYTES)
            if (!constantTimeEquals(publicKey, embeddedPublicKey)) {
                throw StreamingSessionException(
                    "invalid_key",
                    "Ephemeral private key public half does not match its seed.",
                )
            }
            val publicKeyBase58 = Base58.encode(publicKey)
            val expectedPublicKey = metadata.optString("ephemeralSignerPubkey")
                .ifBlank { metadata.optString("ephemeralPublicKeyBase58") }
            if (expectedPublicKey.isNotBlank()) {
                val expected = Base58.decode(expectedPublicKey)
                if (expected.size != ED25519_PUBLIC_KEY_BYTES || !constantTimeEquals(expected, publicKey)) {
                    throw StreamingSessionException(
                        "public_key_mismatch",
                        "Ephemeral private key does not match ephemeralSignerPubkey.",
                    )
                }
            }

            val alias = aliasFor(cleanSessionId)
            deleteKeyAlias(alias)
            val encrypted = encryptSecret(alias, cleanSessionId, secret)
            val now = System.currentTimeMillis()
            val record = JSONObject()
                .put("schema", LOCAL_SESSION_SCHEMA)
                .put("sessionId", cleanSessionId)
                .put("status", "active")
                .put("keyAlias", alias)
                .put("keyAad", cleanSessionId)
                .put("iv", encrypted.ivBase64)
                .put("ciphertext", encrypted.ciphertextBase64)
                .put("ephemeralSignerPubkey", publicKeyBase58)
                .put("createdAtMs", now)
                .put("updatedAtMs", now)
                .put("signedVoucherCount", 0)
            copyOptionalString(metadata, record, "expiresAt")
            copyOptionalString(metadata, record, "capAmount")
            copyOptionalString(metadata, record, "spentAmount")
            copyOptionalString(metadata, record, "remainingAmount")
            copyOptionalString(metadata, record, "tokenSymbol")
            copyOptionalInt(metadata, record, "tokenDecimals")
            metadata.optJSONArray("recipientAllowlist")?.let { record.put("recipientAllowlist", JSONArray(it.toString())) }
            if (!record.has("remainingAmount")) {
                computeRemaining(record.optString("capAmount"), record.optString("spentAmount"))
                    ?.let { record.put("remainingAmount", normalizeDecimal(it)) }
            }
            val expiresAt = record.optString("expiresAt")
            if (expiresAt.isNotBlank()) {
                parseIsoTimestamp(expiresAt, "expiresAt")
            }

            prefs.edit().putString(prefKey(cleanSessionId), record.toString()).apply()
            AgentMwaLog.info(
                "StreamingSessionController",
                "createSession",
                "DONE",
                "streaming session key stored",
                mapOf("sessionId" to cleanSessionId, "ephemeralSignerPubkey" to publicKeyBase58),
            )
            return JSONObject()
                .put("sessionId", cleanSessionId)
                .put("ephemeralSignerPubkey", publicKeyBase58)
                .put("signerRuntime", SIGNER_RUNTIME_ANDROID)
                .put("activeSessions", activeSessionCountLocked())
        } finally {
            Arrays.fill(secret, 0)
            Arrays.fill(seed, 0)
        }
    }

    @Synchronized
    fun bindPreparedSession(
        sessionId: String,
        signerId: String,
        metadata: JSONObject = JSONObject(),
    ): JSONObject {
        val cleanSessionId = requireSessionId(sessionId)
        val cleanSignerId = requireSignerId(signerId)
        val existing = loadRecord(cleanSessionId)
        if (existing != null) {
            if (existing.optString("signerId") != cleanSignerId) {
                throw StreamingSessionException("signer_mismatch", "Local session is already bound to a different signer.")
            }
            mergeSessionMetadata(existing, metadata)
            prefs.edit().putString(prefKey(cleanSessionId), existing.toString()).apply()
            return bindResult(existing)
        }

        val prepared = loadSignerRecord(cleanSignerId)
            ?: throw StreamingSessionException("signer_not_found", "No prepared streaming signer exists for $cleanSignerId.")
        if (prepared.optString("status") != "prepared") {
            throw StreamingSessionException("signer_not_prepared", "Prepared signer $cleanSignerId is not bindable.")
        }
        val expectedPublicKey = metadata.optString("ephemeralSignerPubkey")
            .ifBlank { metadata.optString("ephemeralPublicKeyBase58") }
        if (expectedPublicKey.isNotBlank() && expectedPublicKey != prepared.optString("ephemeralSignerPubkey")) {
            throw StreamingSessionException("public_key_mismatch", "Prepared signer does not match ephemeralSignerPubkey.")
        }

        val now = System.currentTimeMillis()
        val record = JSONObject(prepared.toString())
            .put("schema", LOCAL_SESSION_SCHEMA)
            .put("sessionId", cleanSessionId)
            .put("signerId", cleanSignerId)
            .put("status", "pending")
            .put("updatedAtMs", now)
            .put("signedVoucherCount", 0)
            .put("signedVouchers", JSONObject())
        mergeSessionMetadata(record, metadata)
        prefs.edit()
            .putString(prefKey(cleanSessionId), record.toString())
            .remove(signerPrefKey(cleanSignerId))
            .apply()
        AgentMwaLog.info(
            "StreamingSessionController",
            "bindPreparedSession",
            "DONE",
            "native streaming signer bound to session",
            mapOf("sessionId" to cleanSessionId, "signerId" to cleanSignerId),
        )
        return bindResult(record)
    }

    @Synchronized
    fun activateSession(sessionId: String, metadata: JSONObject = JSONObject()): JSONObject {
        val cleanSessionId = requireSessionId(sessionId)
        val record = loadRecord(cleanSessionId)
            ?: throw StreamingSessionException("session_not_found", "No local streaming session key exists for $cleanSessionId.")
        val status = record.optString("status", "pending")
        if (status != "pending" && status != "active") {
            throw StreamingSessionException("session_not_activatable", "Session $cleanSessionId is $status.")
        }
        mergeSessionMetadata(record, metadata)
        record
            .put("status", "active")
            .put("updatedAtMs", System.currentTimeMillis())
        prefs.edit().putString(prefKey(cleanSessionId), record.toString()).apply()
        AgentMwaLog.info(
            "StreamingSessionController",
            "activateSession",
            "DONE",
            "local streaming session activated",
            mapOf("sessionId" to cleanSessionId),
        )
        return JSONObject()
            .put("sessionId", cleanSessionId)
            .put("status", "active")
            .put("ephemeralSignerPubkey", record.optString("ephemeralSignerPubkey"))
            .put("activeSessions", activeSessionCountLocked())
    }

    @Synchronized
    fun signVoucher(sessionId: String, voucherJson: String): JSONObject {
        val startedAt = System.nanoTime()
        val cleanSessionId = requireSessionId(sessionId)
        val record = loadRecord(cleanSessionId)
            ?: throw StreamingSessionException("session_not_found", "No local streaming session key exists for $cleanSessionId.")
        requireActive(record)
        val voucher = parseVoucher(voucherJson)
        val voucherSessionId = requireJsonString(voucher, "sessionId")
        if (voucherSessionId != cleanSessionId) {
            throw StreamingSessionException("session_mismatch", "Voucher sessionId does not match the requested session.")
        }
        val recipient = requireJsonString(voucher, "recipient")
        requireRecipientAllowed(record, recipient)
        val tokenDecimals = tokenDecimalsFor(record.opt("tokenDecimals"))
        val amount = requireJsonString(voucher, "amount")
        validateAmount(amount, tokenDecimals)
        val digest = voucherDigest(voucher)
        val voucherHash = hex(digest)
        val nonce = requireJsonString(voucher, "nonce")
        existingSignedVoucher(record, nonce)?.let { existing ->
            if (existing.optString("voucherHash") != voucherHash) {
                throw StreamingSessionException("nonce_conflict", "Voucher nonce was already signed for a different payload.")
            }
            val latencyMs = (System.nanoTime() - startedAt) / 1_000_000.0
            return JSONObject()
                .put("sessionId", cleanSessionId)
                .put("signature", existing.getString("signature"))
                .put("signatureEncoding", "base58")
                .put("voucherHash", voucherHash)
                .put("cached", true)
                .put("latencyMs", latencyMs)
                .put("activeSessions", activeSessionCountLocked())
        }
        requireWithinRemaining(record, amount)
        val secret = decryptSecret(record, cleanSessionId)
        var seed = ByteArray(0)
        try {
            seed = secret.copyOfRange(0, ED25519_SEED_BYTES)
            val signature = signDigest(seed, digest)
            val signatureBase58 = Base58.encode(signature)
            rememberSignedVoucher(record, voucher, voucherHash, signatureBase58)
            updateOptimisticSpend(record, voucher)
            val latencyMs = (System.nanoTime() - startedAt) / 1_000_000.0
            AgentMwaLog.info(
                "StreamingSessionController",
                "signVoucher",
                "DONE",
                "streaming voucher signed locally",
                mapOf(
                    "sessionId" to cleanSessionId,
                    "nonce" to voucher.optString("nonce"),
                    "latencyMs" to String.format(Locale.US, "%.3f", latencyMs),
                ),
            )
            return JSONObject()
                .put("sessionId", cleanSessionId)
                .put("signature", signatureBase58)
                .put("signatureEncoding", "base58")
                .put("voucherHash", voucherHash)
                .put("cached", false)
                .put("latencyMs", latencyMs)
                .put("activeSessions", activeSessionCountLocked())
        } finally {
            Arrays.fill(secret, 0)
            Arrays.fill(seed, 0)
        }
    }

    @Synchronized
    fun signSettlementTx(sessionId: String, settlement: JSONObject): JSONObject {
        val startedAt = System.nanoTime()
        val cleanSessionId = requireSessionId(sessionId)
        val record = loadRecord(cleanSessionId)
            ?: throw StreamingSessionException("session_not_found", "No local streaming session key exists for $cleanSessionId.")
        requireSettlementSignable(record)
        requireKnownVoucherHashes(record, settlement.optJSONArray("voucherHashes"))
        val txBase64 = settlement.optString("txBase64")
            .ifBlank { settlement.optString("transactionBase64") }
        if (txBase64.isBlank()) {
            throw StreamingSessionException("invalid_payload", "signSettlementTx requires txBase64.")
        }
        requireOnlyLocalRequiredSigner(record, settlement.optJSONArray("requiredSigners"))
        val txBytes = decodeBase64(txBase64, "txBase64")
        val unsigned = txBytes.copyOf()
        val messageInfo = parseSingleSignerTransaction(txBytes, Base58.decode(record.getString("ephemeralSignerPubkey")))
        val secret = decryptSecret(record, cleanSessionId)
        var seed = ByteArray(0)
        try {
            seed = secret.copyOfRange(0, ED25519_SEED_BYTES)
            val signature = signDigest(seed, messageInfo.message)
            System.arraycopy(signature, 0, txBytes, messageInfo.signatureOffset, signature.size)
            val latencyMs = (System.nanoTime() - startedAt) / 1_000_000.0
            AgentMwaLog.info(
                "StreamingSessionController",
                "signSettlementTx",
                "DONE",
                "streaming settlement transaction signed locally",
                mapOf("sessionId" to cleanSessionId, "latencyMs" to String.format(Locale.US, "%.3f", latencyMs)),
            )
            return JSONObject()
                .put("sessionId", cleanSessionId)
                .put("signedTransactionBase64", Base64.encodeToString(txBytes, Base64.NO_WRAP))
                .put("signature", Base58.encode(signature))
                .put("signatureEncoding", "base58")
                .put("latencyMs", latencyMs)
                .put("changed", !constantTimeEquals(unsigned, txBytes))
        } finally {
            Arrays.fill(secret, 0)
            Arrays.fill(seed, 0)
        }
    }

    @Synchronized
    fun revokeLocalSession(sessionId: String): JSONObject {
        val cleanSessionId = sessionId.trim()
        val record = if (SESSION_ID_PATTERN.matches(cleanSessionId)) {
            loadRecord(cleanSessionId)
        } else if (SIGNER_ID_PATTERN.matches(cleanSessionId)) {
            loadSignerRecord(cleanSessionId)
        } else {
            throw StreamingSessionException("invalid_session", "Invalid streaming session id.")
        }
        record?.optString("keyAlias")?.takeIf { it.isNotBlank() }?.let { deleteKeyAlias(it) }
        val edit = prefs.edit()
        if (SESSION_ID_PATTERN.matches(cleanSessionId)) edit.remove(prefKey(cleanSessionId))
        if (SIGNER_ID_PATTERN.matches(cleanSessionId)) edit.remove(signerPrefKey(cleanSessionId))
        edit.apply()
        AgentMwaLog.info(
            "StreamingSessionController",
            "revokeLocalSession",
            "DONE",
            "local streaming session key deleted",
            mapOf("sessionId" to cleanSessionId, "existed" to (record != null)),
        )
        return JSONObject()
            .put("sessionId", cleanSessionId)
            .put("revoked", true)
            .put("activeSessions", activeSessionCountLocked())
    }

    @Synchronized
    fun statusJson(): JSONObject {
        val notification = notificationStateLocked()
        return JSONObject()
            .put("available", true)
            .put("runtime", "android-native")
            .put("signerRuntime", SIGNER_RUNTIME_ANDROID)
            .put("activeSessions", notification.activeCount)
            .put("remainingDisplay", notification.remainingDisplay)
            .put("message", notification.text)
            .put("capabilities", JSONArray(listOf(
                "prepareSessionSigner",
                "createSession",
                "activateSession",
                "signVoucher",
                "signSettlementTx",
                "revokeLocalSession",
            )))
    }

    @Synchronized
    fun notificationState(): StreamingSessionNotificationState = notificationStateLocked()

    private fun requireActive(record: JSONObject) {
        val sessionId = record.optString("sessionId")
        val status = record.optString("status", "active")
        if (status != "active") {
            throw StreamingSessionException("session_not_active", "Session $sessionId is $status.")
        }
        val expiresAt = record.optString("expiresAt")
        if (expiresAt.isBlank()) return
        val expiresAtMs = parseIsoTimestamp(expiresAt, "expiresAt").time
        if (System.currentTimeMillis() >= expiresAtMs) {
            record.put("status", "expired").put("updatedAtMs", System.currentTimeMillis())
            prefs.edit().putString(prefKey(sessionId), record.toString()).apply()
            throw StreamingSessionException("session_expired", "Session $sessionId expired at $expiresAt.")
        }
    }

    private fun requireRecipientAllowed(record: JSONObject, recipient: String) {
        val allowlist = record.optJSONArray("recipientAllowlist") ?: return
        for (index in 0 until allowlist.length()) {
            if (allowlist.optString(index) == recipient) return
        }
        throw StreamingSessionException("recipient_not_allowed", "Voucher recipient is not in the session allowlist.")
    }

    private fun updateOptimisticSpend(record: JSONObject, voucher: JSONObject) {
        val now = System.currentTimeMillis()
        val amount = decimalOrNull(voucher.optString("amount")) ?: BigDecimal.ZERO
        decimalOrNull(record.optString("remainingAmount"))?.let { remaining ->
            val nextRemaining = (remaining - amount).max(BigDecimal.ZERO)
            record.put("remainingAmount", normalizeDecimal(nextRemaining))
        }
        decimalOrNull(record.optString("spentAmount"))?.let { spent ->
            record.put("spentAmount", normalizeDecimal(spent + amount))
        }
        record
            .put("signedVoucherCount", record.optInt("signedVoucherCount", 0) + 1)
            .put("lastSignedAtMs", now)
            .put("updatedAtMs", now)
        prefs.edit().putString(prefKey(record.getString("sessionId")), record.toString()).apply()
    }

    private fun notificationStateLocked(): StreamingSessionNotificationState {
        var active = 0
        var remaining = BigDecimal.ZERO
        var hasRemaining = false
        for (record in allRecords()) {
            val sessionId = record.optString("sessionId")
            if (record.optString("status", "active") != "active") continue
            val expiresAt = record.optString("expiresAt")
            if (expiresAt.isNotBlank() && System.currentTimeMillis() >= parseIsoTimestamp(expiresAt, "expiresAt").time) {
                record.put("status", "expired").put("updatedAtMs", System.currentTimeMillis())
                prefs.edit().putString(prefKey(sessionId), record.toString()).apply()
                continue
            }
            active += 1
            decimalOrNull(record.optString("remainingAmount"))?.let {
                remaining += it
                hasRemaining = true
            }
        }
        val remainingDisplay = moneyDisplay(if (hasRemaining) remaining else BigDecimal.ZERO)
        val sessionLabel = if (active == 1) "session" else "sessions"
        val text = "Streaming session active — $active $sessionLabel, $remainingDisplay remaining."
        return StreamingSessionNotificationState(active, remainingDisplay, text)
    }

    private fun activeSessionCountLocked(): Int = notificationStateLocked().activeCount

    private fun allRecords(): List<JSONObject> =
        prefs.all.entries
            .asSequence()
            .filter { it.key.startsWith(PREF_KEY_PREFIX) }
            .mapNotNull { (_, value) ->
                try {
                    JSONObject(value as? String ?: return@mapNotNull null)
                } catch (_: Exception) {
                    null
                }
            }
            .toList()

    private fun loadRecord(sessionId: String): JSONObject? {
        val raw = prefs.getString(prefKey(sessionId), null) ?: return null
        return try {
            JSONObject(raw)
        } catch (err: Exception) {
            throw StreamingSessionException("corrupt_session", "Local streaming session metadata is corrupt.", err)
        }
    }

    private fun loadSignerRecord(signerId: String): JSONObject? {
        val raw = prefs.getString(signerPrefKey(signerId), null) ?: return null
        return try {
            JSONObject(raw)
        } catch (err: Exception) {
            throw StreamingSessionException("corrupt_session", "Prepared streaming signer metadata is corrupt.", err)
        }
    }

    private fun bindResult(record: JSONObject): JSONObject =
        JSONObject()
            .put("sessionId", record.getString("sessionId"))
            .put("signerId", record.optString("signerId"))
            .put("status", record.optString("status"))
            .put("ephemeralSignerPubkey", record.optString("ephemeralSignerPubkey"))
            .put("signerRuntime", SIGNER_RUNTIME_ANDROID)
            .put("activeSessions", activeSessionCountLocked())

    private fun mergeSessionMetadata(record: JSONObject, metadata: JSONObject) {
        copyOptionalString(metadata, record, "expiresAt")
        copyOptionalString(metadata, record, "capAmount")
        copyOptionalString(metadata, record, "spentAmount")
        copyOptionalString(metadata, record, "remainingAmount")
        copyOptionalString(metadata, record, "tokenSymbol")
        copyOptionalInt(metadata, record, "tokenDecimals")
        metadata.optJSONArray("recipientAllowlist")?.let { record.put("recipientAllowlist", JSONArray(it.toString())) }
        val expectedPublicKey = metadata.optString("ephemeralSignerPubkey")
            .ifBlank { metadata.optString("ephemeralPublicKeyBase58") }
        if (expectedPublicKey.isNotBlank()) record.put("ephemeralSignerPubkey", expectedPublicKey)
        if (!record.has("remainingAmount")) {
            computeRemaining(record.optString("capAmount"), record.optString("spentAmount"))
                ?.let { record.put("remainingAmount", normalizeDecimal(it)) }
        }
        val expiresAt = record.optString("expiresAt")
        if (expiresAt.isNotBlank()) parseIsoTimestamp(expiresAt, "expiresAt")
        record.put("signerRuntime", SIGNER_RUNTIME_ANDROID)
    }

    private fun encryptSecret(alias: String, sessionId: String, secret: ByteArray): EncryptedSecret {
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey(alias))
        cipher.updateAAD(sessionId.toByteArray(Charsets.UTF_8))
        return EncryptedSecret(
            ivBase64 = Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            ciphertextBase64 = Base64.encodeToString(cipher.doFinal(secret), Base64.NO_WRAP),
        )
    }

    private fun decryptSecret(record: JSONObject, sessionId: String): ByteArray {
        val alias = record.optString("keyAlias")
            .takeIf { it.isNotBlank() }
            ?: throw StreamingSessionException("corrupt_session", "Local streaming session key alias is missing.")
        val iv = decodeBase64(record.optString("iv"), "iv")
        val ciphertext = decodeBase64(record.optString("ciphertext"), "ciphertext")
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(alias), GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
        cipher.updateAAD(record.optString("keyAad").ifBlank { sessionId }.toByteArray(Charsets.UTF_8))
        val secret = cipher.doFinal(ciphertext)
        if (secret.size != ED25519_SECRET_KEY_BYTES) {
            Arrays.fill(secret, 0)
            throw StreamingSessionException("invalid_key", "Stored streaming session key has an invalid length.")
        }
        return secret
    }

    private fun secretKey(alias: String): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun deleteKeyAlias(alias: String) {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(alias)) {
            keyStore.deleteEntry(alias)
        }
    }

    private fun voucherDigest(voucher: JSONObject): ByteArray {
        val payload = JSONObject()
            .put("schema", requireJsonString(voucher, "schema"))
            .put("sessionId", requireJsonString(voucher, "sessionId"))
            .put("nonce", requireJsonString(voucher, "nonce"))
            .put("amount", requireJsonString(voucher, "amount"))
            .put("recipient", requireJsonString(voucher, "recipient"))
            .put("issuedAt", requireJsonString(voucher, "issuedAt"))
        if (payload.getString("schema") != STREAMING_VOUCHER_SCHEMA) {
            throw StreamingSessionException("invalid_schema", "Voucher schema must be $STREAMING_VOUCHER_SCHEMA.")
        }
        parseIsoTimestamp(payload.getString("issuedAt"), "issuedAt")
        val canonical = canonicalize(payload)
        return MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
    }

    private fun signDigest(seed: ByteArray, digest: ByteArray): ByteArray {
        val privateKey = Ed25519PrivateKeyParameters(seed, 0)
        val signer = Ed25519Signer()
        signer.init(true, privateKey)
        signer.update(digest, 0, digest.size)
        return signer.generateSignature()
    }

    private fun existingSignedVoucher(record: JSONObject, nonce: String): JSONObject? =
        record.optJSONObject("signedVouchers")?.optJSONObject(nonce)

    private fun rememberSignedVoucher(record: JSONObject, voucher: JSONObject, voucherHash: String, signatureBase58: String) {
        val signed = record.optJSONObject("signedVouchers") ?: JSONObject().also { record.put("signedVouchers", it) }
        val nonce = requireJsonString(voucher, "nonce")
        signed.put(
            nonce,
            JSONObject()
                .put("voucherHash", voucherHash)
                .put("signature", signatureBase58)
                .put("amount", requireJsonString(voucher, "amount"))
                .put("recipient", requireJsonString(voucher, "recipient"))
                .put("issuedAt", requireJsonString(voucher, "issuedAt")),
        )
    }

    private fun requireWithinRemaining(record: JSONObject, amount: String) {
        val amountDecimal = decimalOrNull(amount)
            ?: throw StreamingSessionException("invalid_amount", "Voucher amount must be a decimal string.")
        val remaining = decimalOrNull(record.optString("remainingAmount"))
            ?: computeRemaining(record.optString("capAmount"), record.optString("spentAmount"))
            ?: return
        if (amountDecimal > remaining) {
            throw StreamingSessionException("voucher_exceeds_remaining", "Voucher amount exceeds local remaining session balance.")
        }
    }

    private fun requireSettlementSignable(record: JSONObject) {
        val status = record.optString("status", "active")
        if (status != "active" && status != "revoked" && status != "expired") {
            throw StreamingSessionException("session_not_settlement_signable", "Session ${record.optString("sessionId")} is $status.")
        }
    }

    private fun requireKnownVoucherHashes(record: JSONObject, voucherHashes: JSONArray?) {
        if (voucherHashes == null || voucherHashes.length() == 0) return
        val known = mutableSetOf<String>()
        val signed = record.optJSONObject("signedVouchers") ?: JSONObject()
        val keys = signed.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val hash = signed.optJSONObject(key)?.optString("voucherHash").orEmpty()
            if (hash.isNotBlank()) known.add(hash)
        }
        for (index in 0 until voucherHashes.length()) {
            val hash = voucherHashes.optString(index)
            if (!known.contains(hash)) {
                throw StreamingSessionException("unknown_voucher_hash", "Settlement references a voucher that was not signed locally.")
            }
        }
    }

    private fun requireOnlyLocalRequiredSigner(record: JSONObject, requiredSigners: JSONArray?) {
        if (requiredSigners == null) return
        val local = record.getString("ephemeralSignerPubkey")
        for (index in 0 until requiredSigners.length()) {
            val signer = requiredSigners.optString(index)
            if (signer != local) {
                throw StreamingSessionException("unsupported_settlement_signer", "Native settlement signing only supports the local delegate signer.")
            }
        }
    }

    private fun parseSingleSignerTransaction(txBytes: ByteArray, localPublicKey: ByteArray): ParsedTransactionMessage {
        val sigCountRead = readShortVec(txBytes, 0)
        val signatureCount = sigCountRead.value
        if (signatureCount != 1) {
            throw StreamingSessionException("unsupported_settlement_tx", "Native settlement signing requires a single delegate signature.")
        }
        val signatureOffset = sigCountRead.nextOffset
        val messageOffset = signatureOffset + ED25519_SIGNATURE_BYTES
        if (messageOffset >= txBytes.size) {
            throw StreamingSessionException("invalid_transaction", "Settlement transaction is truncated.")
        }
        val message = txBytes.copyOfRange(messageOffset, txBytes.size)
        val headerOffset = if ((message[0].toInt() and 0x80) != 0) 1 else 0
        if (message.size < headerOffset + 4) {
            throw StreamingSessionException("invalid_transaction", "Settlement transaction message is truncated.")
        }
        val requiredSignatures = message[headerOffset].toInt() and 0xff
        if (requiredSignatures != 1) {
            throw StreamingSessionException("unsupported_settlement_tx", "Settlement transaction must require only the delegate signer.")
        }
        val accountCountRead = readShortVec(message, headerOffset + 3)
        val accountKeyOffset = accountCountRead.nextOffset
        if (accountCountRead.value < 1 || accountKeyOffset + ED25519_PUBLIC_KEY_BYTES > message.size) {
            throw StreamingSessionException("invalid_transaction", "Settlement transaction has no signer account key.")
        }
        val signerKey = message.copyOfRange(accountKeyOffset, accountKeyOffset + ED25519_PUBLIC_KEY_BYTES)
        if (!constantTimeEquals(signerKey, localPublicKey)) {
            throw StreamingSessionException("signer_mismatch", "Settlement transaction signer does not match the local session delegate.")
        }
        return ParsedTransactionMessage(signatureOffset, message)
    }

    private fun readShortVec(bytes: ByteArray, offset: Int): ShortVecRead {
        var value = 0
        var shift = 0
        var cursor = offset
        while (cursor < bytes.size) {
            val current = bytes[cursor].toInt() and 0xff
            value = value or ((current and 0x7f) shl shift)
            cursor += 1
            if ((current and 0x80) == 0) return ShortVecRead(value, cursor)
            shift += 7
            if (shift > 21) break
        }
        throw StreamingSessionException("invalid_transaction", "Invalid Solana shortvec encoding.")
    }

    private fun parseVoucher(voucherJson: String): JSONObject =
        try {
            JSONObject(voucherJson)
        } catch (err: Exception) {
            throw StreamingSessionException("invalid_payload", "Voucher payload is not valid JSON.", err)
        }

    private fun decodeSecret(value: String): ByteArray {
        val secret = decodeBase64(value, "ephemeralPrivkeyBase64")
        if (secret.size != ED25519_SECRET_KEY_BYTES) {
            Arrays.fill(secret, 0)
            throw StreamingSessionException(
                "invalid_key",
                "ephemeralPrivkeyBase64 must decode to $ED25519_SECRET_KEY_BYTES bytes.",
            )
        }
        return secret
    }

    private fun decodeBase64(value: String, field: String): ByteArray =
        try {
            Base64.decode(value, Base64.DEFAULT)
        } catch (err: IllegalArgumentException) {
            throw StreamingSessionException("invalid_payload", "$field must be base64.", err)
        }

    private fun requireSessionId(value: String): String {
        val trimmed = value.trim()
        if (!SESSION_ID_PATTERN.matches(trimmed)) {
            throw StreamingSessionException("invalid_session", "Invalid streaming session id.")
        }
        return trimmed
    }

    private fun requireSignerId(value: String): String {
        val trimmed = value.trim()
        if (!SIGNER_ID_PATTERN.matches(trimmed)) {
            throw StreamingSessionException("invalid_signer", "Invalid streaming signer id.")
        }
        return trimmed
    }

    private fun requireJsonString(json: JSONObject, field: String): String {
        val value = json.optString(field, "")
        if (value.isBlank()) {
            throw StreamingSessionException("invalid_payload", "$field must be a non-empty string.")
        }
        return value
    }

    private fun validateAmount(amount: String, decimals: Int) {
        val match = DECIMAL_AMOUNT_PATTERN.matchEntire(amount)
            ?: throw StreamingSessionException("invalid_amount", "Voucher amount must be a non-negative decimal string.")
        val fraction = match.groups[1]?.value.orEmpty()
        if (fraction.length > decimals) {
            throw StreamingSessionException("invalid_amount", "Voucher amount has more than $decimals decimal places.")
        }
        val parsed = decimalOrNull(amount)
            ?: throw StreamingSessionException("invalid_amount", "Voucher amount must be a decimal string.")
        if (parsed <= BigDecimal.ZERO) {
            throw StreamingSessionException("invalid_amount", "Voucher amount must be greater than zero.")
        }
    }

    private fun tokenDecimalsFor(value: Any?): Int {
        if (value == null || value == JSONObject.NULL) return DEFAULT_TOKEN_DECIMALS
        val intValue = when (value) {
            is Number -> value.toInt()
            is String -> value.toIntOrNull()
            else -> null
        } ?: throw StreamingSessionException("invalid_payload", "tokenDecimals must be an integer.")
        if (intValue < 0 || intValue > 255) {
            throw StreamingSessionException("invalid_payload", "tokenDecimals must be between 0 and 255.")
        }
        return intValue
    }

    private fun canonicalize(value: Any?): String {
        if (value == null || value == JSONObject.NULL) return "null"
        return when (value) {
            is Boolean -> if (value) "true" else "false"
            is Number -> value.toString()
            is String -> JSONObject.quote(value)
            is JSONArray -> {
                val entries = (0 until value.length()).joinToString(",") { index ->
                    canonicalize(value.opt(index))
                }
                "[$entries]"
            }
            is JSONObject -> {
                val keys = value.keys().asSequence().toList().sorted()
                val entries = keys.joinToString(",") { key ->
                    "${JSONObject.quote(key)}:${canonicalize(value.opt(key))}"
                }
                "{$entries}"
            }
            else -> throw StreamingSessionException("invalid_payload", "Cannot canonicalize ${value.javaClass.simpleName}.")
        }
    }

    private fun parseIsoTimestamp(value: String, field: String): Date {
        val trimmed = value.trim()
        for (format in ISO_FORMATS.get()!!) {
            try {
                return format.parse(trimmed) ?: break
            } catch (_: Exception) {
                // Try the next accepted ISO-8601 shape.
            }
        }
        throw StreamingSessionException("invalid_payload", "$field must be a valid ISO-8601 timestamp.")
    }

    private fun aliasFor(sessionId: String): String =
        "$KEY_ALIAS_PREFIX${sha256Hex(sessionId.toByteArray(Charsets.UTF_8)).take(48)}"

    private fun prefKey(sessionId: String): String = "$PREF_KEY_PREFIX$sessionId"

    private fun signerPrefKey(signerId: String): String = "$SIGNER_PREF_KEY_PREFIX$signerId"

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun hex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun newSignerId(): String {
        val bytes = ByteArray(18)
        SecureRandom().nextBytes(bytes)
        return "signer_${hex(bytes)}"
    }

    private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (index in a.indices) {
            diff = diff or ((a[index].toInt() xor b[index].toInt()) and 0xff)
        }
        return diff == 0
    }

    private fun copyOptionalString(source: JSONObject, target: JSONObject, key: String) {
        val value = source.optString(key, "")
        if (value.isNotBlank()) target.put(key, value)
    }

    private fun copyOptionalInt(source: JSONObject, target: JSONObject, key: String) {
        if (source.has(key) && !source.isNull(key)) target.put(key, source.getInt(key))
    }

    private fun computeRemaining(capAmount: String, spentAmount: String): BigDecimal? {
        val cap = decimalOrNull(capAmount) ?: return null
        val spent = decimalOrNull(spentAmount.ifBlank { "0" }) ?: return null
        return (cap - spent).max(BigDecimal.ZERO)
    }

    private fun decimalOrNull(value: String): BigDecimal? =
        try {
            if (value.isBlank()) null else BigDecimal(value)
        } catch (_: Exception) {
            null
        }

    private fun normalizeDecimal(value: BigDecimal): String =
        value.stripTrailingZeros().toPlainString().let { if (it == "0E-7") "0" else it }

    private fun moneyDisplay(value: BigDecimal): String =
        "$" + value.setScale(2, RoundingMode.DOWN).toPlainString()

    private data class EncryptedSecret(val ivBase64: String, val ciphertextBase64: String)
    private data class ShortVecRead(val value: Int, val nextOffset: Int)
    private data class ParsedTransactionMessage(val signatureOffset: Int, val message: ByteArray)

    companion object {
        const val STREAMING_VOUCHER_SCHEMA = "streaming/voucher/0.1"
        private const val SIGNER_RUNTIME_ANDROID = "android-native"
        private const val LOCAL_SESSION_SCHEMA = "agentic/android-streaming-session/1"
        private const val LOCAL_SIGNER_SCHEMA = "agentic/android-streaming-signer/1"
        private const val PREFS_NAME = "AgenticStreamingSessions"
        private const val PREF_KEY_PREFIX = "session."
        private const val SIGNER_PREF_KEY_PREFIX = "signer."
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS_PREFIX = "AgenticStreamingSession."
        private const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val ED25519_SEED_BYTES = 32
        private const val ED25519_PUBLIC_KEY_BYTES = 32
        private const val ED25519_SECRET_KEY_BYTES = 64
        private const val ED25519_SIGNATURE_BYTES = 64
        private const val DEFAULT_TOKEN_DECIMALS = 6
        private val SESSION_ID_PATTERN = Regex("^[A-Za-z0-9_.:-]{1,160}$")
        private val SIGNER_ID_PATTERN = Regex("^signer_[a-f0-9]{36}$")
        private val DECIMAL_AMOUNT_PATTERN = Regex("^(?:0|[1-9]\\d*)(?:\\.(\\d+))?$")
        private val ISO_FORMATS: ThreadLocal<List<SimpleDateFormat>> = object : ThreadLocal<List<SimpleDateFormat>>() {
            override fun initialValue(): List<SimpleDateFormat> {
                val zone = TimeZone.getTimeZone("UTC")
                return listOf(
                    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                    "yyyy-MM-dd'T'HH:mm:ss'Z'",
                    "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
                    "yyyy-MM-dd'T'HH:mm:ssXXX",
                ).map { pattern ->
                    SimpleDateFormat(pattern, Locale.US).apply {
                        timeZone = zone
                        isLenient = false
                    }
                }
            }
        }
    }
}

data class StreamingSessionNotificationState(
    val activeCount: Int,
    val remainingDisplay: String,
    val text: String,
)

class StreamingSessionException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)
