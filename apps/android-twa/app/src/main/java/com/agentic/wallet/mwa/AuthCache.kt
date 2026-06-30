package com.agentic.wallet.mwa

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.content.Context
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AuthCache(context: Context) {
    private val cacheDir = File(context.filesDir, "AgentAndroidMWA")
    private val legacyCacheFile = File(cacheDir, "AuthCache.json")
    private val encryptedCacheFile = File(cacheDir, "AuthCache.v2.enc")
    private val encryptor = AuthCacheEncryptor()
    private val records = LinkedHashMap<String, AgentMwaAuthRecord>()
    private val blacklist = mutableSetOf<String>()
    private var latestSessionKey: String = ""
    private var loaded = false

    @Synchronized
    fun get(pubkeyBase58: String): AgentMwaAuthRecord? {
        ensureLoaded()
        val record = records.values
            .filter { it.publicKeyBase58 == pubkeyBase58 }
            .filterNot { blacklist.contains(sessionKey(it)) }
            .maxByOrNull { it.timestampUnixSeconds }
        // Cocos parity: log age on every read so stale entries are visible in diagnostics.
        if (record != null) {
            val ageSeconds = ((System.currentTimeMillis() / 1000L) - record.timestampUnixSeconds).coerceAtLeast(0L)
            AgentMwaLog.debug(
                "AuthCache",
                "get",
                "HIT",
                "cached authorization read",
                mapOf("pubkey" to pubkeyBase58, "sessionKey" to sessionKey(record), "ageSeconds" to ageSeconds, "authTokenLen" to record.authToken.length),
            )
        }
        return record
    }

    @Synchronized
    fun getBySessionKey(sessionKey: String): AgentMwaAuthRecord? {
        ensureLoaded()
        val key = sessionKey.trim()
        if (key.isBlank() || blacklist.contains(key)) return null
        val record = records[key]
        if (record != null) {
            val ageSeconds = ((System.currentTimeMillis() / 1000L) - record.timestampUnixSeconds).coerceAtLeast(0L)
            AgentMwaLog.debug(
                "AuthCache",
                "getBySessionKey",
                "HIT",
                "cached authorization read by exact provider session",
                mapOf("sessionKey" to key, "pubkey" to record.publicKeyBase58, "ageSeconds" to ageSeconds, "authTokenLen" to record.authToken.length),
            )
        }
        return record
    }

    @Synchronized
    fun find(
        pubkeyBase58: String,
        cluster: AgentCluster,
        walletPackage: String = "",
        walletUriBase: String = "",
        walletIcon: String = "",
        walletType: Int = WalletRegistry.UNKNOWN,
    ): AgentMwaAuthRecord? {
        ensureLoaded()
        if (pubkeyBase58.isBlank()) return null
        val requestedKey = authCacheSessionKey(
            publicKeyBase58 = pubkeyBase58,
            cluster = cluster,
            walletPackage = walletPackage,
            walletUriBase = walletUriBase,
            walletIcon = walletIcon,
            walletType = walletType,
        )
        records[requestedKey]
            ?.takeIf { !blacklist.contains(requestedKey) }
            ?.let { return it }

        val providerKey = authCacheProviderKey(walletPackage, walletUriBase, walletIcon, walletType)
        if (providerKey == AUTH_CACHE_PROVIDER_UNKNOWN) return null

        return records.values
            .filter { it.publicKeyBase58 == pubkeyBase58 && it.cluster == cluster }
            .filterNot { blacklist.contains(sessionKey(it)) }
            .filter { authCacheProviderKey(it) == providerKey }
            .maxByOrNull { it.timestampUnixSeconds }
    }

    @Synchronized
    fun latest(): AgentMwaAuthRecord? {
        ensureLoaded()
        latestSessionKey.takeIf { it.isNotBlank() && !blacklist.contains(it) }?.let { latest ->
            records[latest]?.let { return it }
        }
        return records.values
            .filterNot { blacklist.contains(sessionKey(it)) }
            .maxByOrNull { it.timestampUnixSeconds }
    }

    @Synchronized
    fun all(): List<AgentMwaAuthRecord> {
        ensureLoaded()
        return records.values.toList()
    }

    @Synchronized
    fun set(record: AgentMwaAuthRecord) {
        ensureLoaded()
        // Cocos parity (Bug G5 prevention): reject blank or malformed pubkeys before they
        // poison the cache file. Valid Solana base58 pubkeys are 32–44 chars and decode to 32 bytes.
        if (record.publicKeyBase58.isBlank()) {
            AgentMwaLog.warn(
                "AuthCache",
                "set",
                "FAIL_BLANK_PUBKEY",
                "rejected blank pubkey",
                mapOf("authTokenLen" to record.authToken.length),
            )
            return
        }
        if (!isValidBase58Pubkey(record.publicKeyBase58)) {
            AgentMwaLog.warn(
                "AuthCache",
                "set",
                "FAIL_INVALID_PUBKEY",
                "rejected malformed pubkey",
                mapOf("pubkey" to record.publicKeyBase58, "pubkeyLen" to record.publicKeyBase58.length, "authTokenLen" to record.authToken.length),
            )
            return
        }
        val sessionKey = sessionKey(record)
        records[sessionKey] = record
        latestSessionKey = sessionKey
        AgentMwaLog.info(
            "AuthCache",
            "set",
            "AUTHCACHE_RECORD_STORE",
            "authorization record stored in memory before encrypted save",
            authCacheRecordMetadata(record) + mapOf(
                "sessionKey" to sessionKey,
                "providerKey" to authCacheProviderKey(record),
                "count" to records.size,
            ),
        )
        // Cocos parity (Bug U3 prevention): log authTokenLen so empty/short tokens are visible.
        AgentMwaLog.info(
            "AuthCache",
            "set",
            "STORE",
            "cached authorization written",
            mapOf(
                "pubkey" to record.publicKeyBase58,
                "sessionKey" to sessionKey,
                "providerKey" to authCacheProviderKey(record),
                "authTokenLen" to record.authToken.length,
                "walletType" to record.walletType,
                "walletUriBase" to record.walletUriBase,
                "walletPackage" to record.walletPackage,
                "cluster" to record.cluster.id,
                "authenticated" to record.authenticated,
            ) + WalletRegistry.walletIconLogMetadata(record.walletIcon),
        )
        save()
    }

    private fun isValidBase58Pubkey(pubkey: String): Boolean {
        if (pubkey.length !in 32..44) return false
        return try {
            Base58.decode(pubkey).size == 32
        } catch (_: Throwable) {
            false
        }
    }

    @Synchronized
    fun clear(pubkeyBase58: String, blacklistForSession: Boolean = true) {
        ensureLoaded()
        if (pubkeyBase58.isBlank()) return
        val keys = records
            .filterValues { it.publicKeyBase58 == pubkeyBase58 }
            .keys
            .toList()
        for (key in keys) {
            records.remove(key)
            if (blacklistForSession) {
                blacklist.add(key)
            }
        }
        if (keys.contains(latestSessionKey)) {
            latestSessionKey = latestAvailableSessionKey()
        }
        save()
    }

    @Synchronized
    fun clearRecord(record: AgentMwaAuthRecord, blacklistForSession: Boolean = true) {
        ensureLoaded()
        clearSession(sessionKey(record), blacklistForSession)
    }

    @Synchronized
    fun clearSession(sessionKey: String, blacklistForSession: Boolean = true) {
        ensureLoaded()
        val key = sessionKey.trim()
        if (key.isBlank()) return
        records.remove(key)
        if (latestSessionKey == key) {
            latestSessionKey = latestAvailableSessionKey()
        }
        if (blacklistForSession) {
            blacklist.add(key)
        }
        save()
    }

    @Synchronized
    fun clearAll() {
        ensureLoaded()
        records.clear()
        latestSessionKey = ""
        save()
    }

    @Synchronized
    fun clearBlacklist() {
        blacklist.clear()
    }

    @Synchronized
    fun latestPubkey(): String {
        ensureLoaded()
        return latest()?.publicKeyBase58.orEmpty()
    }

    @Synchronized
    fun latestSessionKey(): String {
        ensureLoaded()
        return latest()?.let { sessionKey(it) }.orEmpty()
    }

    fun sessionKey(record: AgentMwaAuthRecord): String = authCacheSessionKey(record)

    private fun latestAvailableSessionKey(): String =
        records.maxByOrNull { it.value.timestampUnixSeconds }?.key ?: ""

    private fun ensureLoaded() {
        if (loaded) return
        loaded = true
        if (encryptedCacheFile.exists()) {
            AgentMwaLog.info(
                "AuthCache",
                "load",
                "AUTHCACHE_LOAD_START",
                "loading encrypted authorization cache",
                mapOf(
                    "source" to "encrypted",
                    "exists" to true,
                    "path" to encryptedCacheFile.absolutePath,
                    "bytes" to encryptedCacheFile.length(),
                ),
            )
            try {
                val plaintext = encryptor.decrypt(encryptedCacheFile.readText(Charsets.UTF_8))
                loadFromPlaintext(plaintext, "encrypted")
            } catch (err: Exception) {
                AgentMwaLog.warn(
                    "AuthCache",
                    "load",
                    "FAIL_ENCRYPTED",
                    "encrypted cache could not be read; forcing reconnect",
                    mapOf("class" to err.javaClass.simpleName, "message" to err.message),
                )
                records.clear()
                latestSessionKey = ""
                val deleted = encryptedCacheFile.delete()
                AgentMwaLog.warn(
                    "AuthCache",
                    "load",
                    "AUTHCACHE_LOAD_FAIL_ENCRYPTED_DELETE",
                    "encrypted authorization cache could not be read and was removed",
                    mapOf(
                        "class" to err.javaClass.simpleName,
                        "message" to err.message,
                        "path" to encryptedCacheFile.absolutePath,
                        "deleted" to deleted,
                    ),
                )
            }
            return
        }
        if (legacyCacheFile.exists()) {
            AgentMwaLog.info(
                "AuthCache",
                "load",
                "AUTHCACHE_LOAD_START",
                "loading legacy authorization cache",
                mapOf(
                    "source" to "legacy",
                    "exists" to true,
                    "path" to legacyCacheFile.absolutePath,
                    "bytes" to legacyCacheFile.length(),
                ),
            )
            try {
                loadFromPlaintext(legacyCacheFile.readText(Charsets.UTF_8), "legacy")
                save()
                if (encryptedCacheFile.exists() && legacyCacheFile.delete()) {
                    AgentMwaLog.info("AuthCache", "migrate", "DONE", "legacy plaintext cache migrated to encrypted storage", mapOf("count" to records.size))
                }
            } catch (err: Exception) {
                AgentMwaLog.warn("AuthCache", "load", "FAIL_LEGACY", "legacy cache parse failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
                records.clear()
                latestSessionKey = ""
            }
            return
        }
        AgentMwaLog.info(
            "AuthCache",
            "load",
            "AUTHCACHE_LOAD_START",
            "authorization cache files are missing",
            mapOf(
                "source" to "none",
                "exists" to false,
                "encryptedPath" to encryptedCacheFile.absolutePath,
                "legacyPath" to legacyCacheFile.absolutePath,
            ),
        )
        AgentMwaLog.info("AuthCache", "load", "SKIP", "cache file missing", mapOf("path" to encryptedCacheFile.absolutePath))
    }

    private fun loadFromPlaintext(plaintext: String, source: String) {
        try {
            val root = JSONObject(plaintext)
            val storedLatest = root.optString("latest", "")
            var latestFromLegacyPubkey = ""
            val objectRecords = root.optJSONObject("records") ?: JSONObject()
            for (key in objectRecords.keys()) {
                val record = recordFromJson(objectRecords.getJSONObject(key))
                if (record.publicKeyBase58.isNotBlank()) {
                    val sessionKey = sessionKey(record)
                    records[sessionKey] = record
                    if (storedLatest == sessionKey || storedLatest == key) {
                        latestSessionKey = sessionKey
                    }
                    if (storedLatest == record.publicKeyBase58 && (
                        latestFromLegacyPubkey.isBlank() ||
                            record.timestampUnixSeconds > (records[latestFromLegacyPubkey]?.timestampUnixSeconds ?: Long.MIN_VALUE)
                    )) {
                        latestFromLegacyPubkey = sessionKey
                    }
                }
            }
            if (latestSessionKey.isBlank()) {
                latestSessionKey = latestFromLegacyPubkey.ifBlank { latestAvailableSessionKey() }
            }
            AgentMwaLog.info(
                "AuthCache",
                "load",
                "AUTHCACHE_LOAD_OK",
                "authorization cache loaded",
                authCacheSummaryMetadata(source),
            )
            AgentMwaLog.info("AuthCache", "load", "DONE", "cache loaded", mapOf("count" to records.size, "latestSessionKey" to latestSessionKey, "source" to source))
        } catch (err: Exception) {
            AgentMwaLog.warn("AuthCache", "load", "FAIL", "cache parse failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
            records.clear()
            latestSessionKey = ""
            throw err
        }
    }

    private fun save() {
        try {
            encryptedCacheFile.parentFile?.mkdirs()
            val root = JSONObject()
                .put("schema", 3)
                .put("latest", latestSessionKey)
            val objectRecords = JSONObject()
            for ((sessionKey, record) in records) {
                objectRecords.put(sessionKey, authRecordToJson(record))
            }
            root.put("records", objectRecords)
            AgentMwaLog.info(
                "AuthCache",
                "save",
                "AUTHCACHE_SAVE_START",
                "saving encrypted authorization cache",
                authCacheSummaryMetadata("encrypted") + mapOf("path" to encryptedCacheFile.absolutePath),
            )
            val encrypted = encryptor.encrypt("${root.toString(2)}\n")
            encryptedCacheFile.writeText("${encrypted.toString(2)}\n", Charsets.UTF_8)
            if (legacyCacheFile.exists() && !legacyCacheFile.delete()) {
                AgentMwaLog.warn("AuthCache", "save", "LEGACY_RETAINED", "legacy plaintext cache could not be deleted")
            }
            AgentMwaLog.info(
                "AuthCache",
                "save",
                "AUTHCACHE_SAVE_OK",
                "encrypted authorization cache saved",
                authCacheSummaryMetadata("encrypted") + mapOf(
                    "path" to encryptedCacheFile.absolutePath,
                    "bytes" to encryptedCacheFile.length(),
                ),
            )
            AgentMwaLog.info("AuthCache", "save", "DONE", "encrypted cache saved", mapOf("count" to records.size, "latestSessionKey" to latestSessionKey))
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "AuthCache",
                "save",
                "AUTHCACHE_SAVE_FAIL",
                "encrypted authorization cache save failed",
                mapOf(
                    "class" to err.javaClass.simpleName,
                    "message" to err.message,
                    "path" to encryptedCacheFile.absolutePath,
                    "count" to records.size,
                    "latestSessionKey" to latestSessionKey,
                ),
            )
            AgentMwaLog.warn("AuthCache", "save", "FAIL", "cache save failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        }
    }

    private fun recordFromJson(json: JSONObject): AgentMwaAuthRecord {
        return authRecordFromJson(json)
    }

    private fun latestRecordWithoutLoading(): AgentMwaAuthRecord? =
        latestSessionKey.takeIf { it.isNotBlank() }?.let { records[it] }
            ?: records.values.maxByOrNull { it.timestampUnixSeconds }

    private fun authCacheSummaryMetadata(source: String): Map<String, Any?> {
        val latest = latestRecordWithoutLoading()
        return mapOf(
            "source" to source,
            "count" to records.size,
            "latestSessionKey" to latestSessionKey,
            "latestPubkey" to latest?.publicKeyBase58.orEmpty(),
            "latestAuthLen" to (latest?.authToken?.length ?: 0),
            "latestAuthenticated" to (latest?.authenticated ?: false),
            "latestUsable" to (latest?.hasUsableAuthorization() ?: false),
            "latestRestorable" to (latest?.hasRestorableAuthorization() ?: false),
            "latestWalletPackage" to latest?.walletPackage.orEmpty(),
            "latestWalletType" to (latest?.walletType ?: WalletRegistry.UNKNOWN),
            "latestCluster" to latest?.cluster?.id.orEmpty(),
        )
    }

    private fun authCacheRecordMetadata(record: AgentMwaAuthRecord): Map<String, Any?> =
        mapOf(
            "pubkey" to record.publicKeyBase58,
            "authLen" to record.authToken.length,
            "authenticated" to record.authenticated,
            "usable" to record.hasUsableAuthorization(),
            "restorable" to record.hasRestorableAuthorization(),
            "walletPackage" to record.walletPackage,
            "walletType" to record.walletType,
            "walletUriBase" to record.walletUriBase,
            "cluster" to record.cluster.id,
            "timestampUnixSeconds" to record.timestampUnixSeconds,
        )
}

private const val AUTH_CACHE_PROVIDER_UNKNOWN = "provider:unknown"

internal fun authCacheSessionKey(record: AgentMwaAuthRecord): String =
    authCacheSessionKey(
        publicKeyBase58 = record.publicKeyBase58,
        cluster = record.cluster,
        walletPackage = record.walletPackage,
        walletUriBase = record.walletUriBase,
        walletIcon = record.walletIcon,
        walletType = record.walletType,
    )

internal fun authCacheSessionKey(
    publicKeyBase58: String,
    cluster: AgentCluster,
    walletPackage: String,
    walletUriBase: String,
    walletIcon: String,
    walletType: Int,
): String {
    val provider = authCacheProviderKey(walletPackage, walletUriBase, walletIcon, walletType)
    return "${cluster.id}|$provider|${publicKeyBase58.trim()}"
}

internal fun authCacheProviderKey(record: AgentMwaAuthRecord): String =
    authCacheProviderKey(record.walletPackage, record.walletUriBase, record.walletIcon, record.walletType)

internal fun authCacheProviderKey(
    walletPackage: String,
    walletUriBase: String,
    walletIcon: String,
    walletType: Int,
): String {
    val inferredPackage = WalletRegistry.inferPackage(walletUriBase, walletPackage, walletIcon)
        .trim()
        .lowercase()
    if (inferredPackage.isNotBlank()) return "pkg:$inferredPackage"
    if (walletType != WalletRegistry.UNKNOWN) return "type:$walletType"
    val uri = walletUriBase.trim().lowercase()
    if (uri.isNotBlank()) return "uri:$uri"
    val icon = walletIcon.trim()
    if (icon.isNotBlank()) return "icon:${sha256First8ForAuthCache(icon.toByteArray(Charsets.UTF_8))}"
    return AUTH_CACHE_PROVIDER_UNKNOWN
}

private fun sha256First8ForAuthCache(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).take(8).joinToString("") { "%02x".format(it.toInt() and 0xff) }

internal fun authRecordToJson(record: AgentMwaAuthRecord): JSONObject =
    JSONObject()
        .put("publicKeyBase58", record.publicKeyBase58)
        .put("publicKeyBytesBase58", Base58.encode(record.publicKeyBytes))
        .put("authToken", record.authToken)
        .put("walletUriBase", record.walletUriBase)
        .put("walletIcon", record.walletIcon)
        .put("walletPackage", record.walletPackage)
        .put("walletType", record.walletType)
        .put("accountLabel", record.accountLabel)
        .put("cluster", record.cluster.id)
        .put("timestampUnixSeconds", record.timestampUnixSeconds)
        .put("authenticated", record.authenticated)
        .put("capabilitiesCsv", record.capabilitiesCsv)

internal fun authRecordFromJson(json: JSONObject): AgentMwaAuthRecord {
    val pubkey = json.optString("publicKeyBase58", "")
    val pubkeyBytes = json.optString("publicKeyBytesBase58", "")
        .takeIf { it.isNotBlank() }
        ?.let { Base58.decode(it) }
        ?: Base58.decode(pubkey)
    val walletPackage = json.optString("walletPackage", "")
    val walletUriBase = json.optString("walletUriBase", "")
    val walletIcon = json.optString("walletIcon", "")
    val inferredWalletPackage = walletPackage.ifBlank { WalletRegistry.inferPackage(walletUriBase, walletIcon = walletIcon) }
    val inferredWalletType = WalletRegistry.walletType(inferredWalletPackage, walletUriBase, walletIcon)
    val storedWalletType = json.optInt("walletType", WalletRegistry.UNKNOWN)
    val authToken = json.optString("authToken", "")
    val authenticated = if (json.has("authenticated")) {
        json.optBoolean("authenticated", false)
    } else {
        authToken.isNotBlank()
    }
    return AgentMwaAuthRecord(
        publicKeyBase58 = pubkey,
        publicKeyBytes = pubkeyBytes,
        authToken = authToken,
        walletUriBase = walletUriBase,
        walletIcon = walletIcon,
        walletPackage = inferredWalletPackage,
        walletType = storedWalletType.takeIf { it != WalletRegistry.UNKNOWN } ?: inferredWalletType,
        accountLabel = json.optString("accountLabel", ""),
        cluster = AgentCluster.fromId(json.optString("cluster", "mainnet-beta")),
        timestampUnixSeconds = json.optLong("timestampUnixSeconds", 0L),
        authenticated = authenticated,
        capabilitiesCsv = json.optString("capabilitiesCsv", ""),
    )
}

private class AuthCacheEncryptor {
    fun encrypt(plaintext: String): JSONObject {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return JSONObject()
            .put("schema", 2)
            .put("alg", "AES-GCM")
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
    }

    fun decrypt(envelopeText: String): String {
        val envelope = JSONObject(envelopeText)
        val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
        val ciphertext = Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
        return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "AgenticAndroidMwaAuthCache"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH_BITS = 128
    }
}
