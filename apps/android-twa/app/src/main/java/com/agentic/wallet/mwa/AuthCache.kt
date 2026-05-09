package com.agentic.wallet.mwa

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.content.Context
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
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
    private var latestPubkey: String = ""
    private var loaded = false

    @Synchronized
    fun get(pubkeyBase58: String): AgentMwaAuthRecord? {
        ensureLoaded()
        return records[pubkeyBase58]
    }

    @Synchronized
    fun latest(): AgentMwaAuthRecord? {
        ensureLoaded()
        latestPubkey.takeIf { it.isNotBlank() && !blacklist.contains(it) }?.let { latest ->
            records[latest]?.let { return it }
        }
        return records.values
            .filterNot { blacklist.contains(it.publicKeyBase58) }
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
        if (record.publicKeyBase58.isBlank()) return
        records[record.publicKeyBase58] = record
        latestPubkey = record.publicKeyBase58
        save()
    }

    @Synchronized
    fun clear(pubkeyBase58: String, blacklistForSession: Boolean = true) {
        ensureLoaded()
        if (pubkeyBase58.isBlank()) return
        records.remove(pubkeyBase58)
        if (latestPubkey == pubkeyBase58) {
            latestPubkey = records.values.maxByOrNull { it.timestampUnixSeconds }?.publicKeyBase58 ?: ""
        }
        if (blacklistForSession) {
            blacklist.add(pubkeyBase58)
        }
        save()
    }

    @Synchronized
    fun clearAll() {
        ensureLoaded()
        records.clear()
        latestPubkey = ""
        save()
    }

    @Synchronized
    fun clearBlacklist() {
        blacklist.clear()
    }

    @Synchronized
    fun latestPubkey(): String {
        ensureLoaded()
        return latestPubkey
    }

    private fun ensureLoaded() {
        if (loaded) return
        loaded = true
        if (encryptedCacheFile.exists()) {
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
                latestPubkey = ""
                encryptedCacheFile.delete()
            }
            return
        }
        if (legacyCacheFile.exists()) {
            try {
                loadFromPlaintext(legacyCacheFile.readText(Charsets.UTF_8), "legacy")
                save()
                if (encryptedCacheFile.exists() && legacyCacheFile.delete()) {
                    AgentMwaLog.info("AuthCache", "migrate", "DONE", "legacy plaintext cache migrated to encrypted storage", mapOf("count" to records.size))
                }
            } catch (err: Exception) {
                AgentMwaLog.warn("AuthCache", "load", "FAIL_LEGACY", "legacy cache parse failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
                records.clear()
                latestPubkey = ""
            }
            return
        }
        AgentMwaLog.info("AuthCache", "load", "SKIP", "cache file missing", mapOf("path" to encryptedCacheFile.absolutePath))
    }

    private fun loadFromPlaintext(plaintext: String, source: String) {
        try {
            val root = JSONObject(plaintext)
            latestPubkey = root.optString("latest", "")
            val objectRecords = root.optJSONObject("records") ?: JSONObject()
            for (key in objectRecords.keys()) {
                val record = recordFromJson(objectRecords.getJSONObject(key))
                if (record.publicKeyBase58.isNotBlank()) {
                    records[record.publicKeyBase58] = record
                }
            }
            AgentMwaLog.info("AuthCache", "load", "DONE", "cache loaded", mapOf("count" to records.size, "latest" to latestPubkey, "source" to source))
        } catch (err: Exception) {
            AgentMwaLog.warn("AuthCache", "load", "FAIL", "cache parse failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
            records.clear()
            latestPubkey = ""
            throw err
        }
    }

    private fun save() {
        try {
            encryptedCacheFile.parentFile?.mkdirs()
            val root = JSONObject()
                .put("schema", 2)
                .put("latest", latestPubkey)
            val objectRecords = JSONObject()
            for ((pubkey, record) in records) {
                objectRecords.put(pubkey, recordToJson(record))
            }
            root.put("records", objectRecords)
            val encrypted = encryptor.encrypt("${root.toString(2)}\n")
            encryptedCacheFile.writeText("${encrypted.toString(2)}\n", Charsets.UTF_8)
            if (legacyCacheFile.exists() && !legacyCacheFile.delete()) {
                AgentMwaLog.warn("AuthCache", "save", "LEGACY_RETAINED", "legacy plaintext cache could not be deleted")
            }
            AgentMwaLog.info("AuthCache", "save", "DONE", "encrypted cache saved", mapOf("count" to records.size, "latest" to latestPubkey))
        } catch (err: Exception) {
            AgentMwaLog.warn("AuthCache", "save", "FAIL", "cache save failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        }
    }

    private fun recordToJson(record: AgentMwaAuthRecord): JSONObject =
        JSONObject()
            .put("publicKeyBase58", record.publicKeyBase58)
            .put("publicKeyBytesBase58", Base58.encode(record.publicKeyBytes))
            .put("authToken", record.authToken)
            .put("walletUriBase", record.walletUriBase)
            .put("walletPackage", record.walletPackage)
            .put("walletType", record.walletType)
            .put("accountLabel", record.accountLabel)
            .put("cluster", record.cluster.id)
            .put("timestampUnixSeconds", record.timestampUnixSeconds)
            .put("authenticated", record.authenticated)
            .put("capabilitiesCsv", record.capabilitiesCsv)

    private fun recordFromJson(json: JSONObject): AgentMwaAuthRecord {
        val pubkey = json.optString("publicKeyBase58", "")
        val pubkeyBytes = json.optString("publicKeyBytesBase58", "")
            .takeIf { it.isNotBlank() }
            ?.let { Base58.decode(it) }
            ?: Base58.decode(pubkey)
        val walletPackage = json.optString("walletPackage", "")
        val walletUriBase = json.optString("walletUriBase", "")
        return AgentMwaAuthRecord(
            publicKeyBase58 = pubkey,
            publicKeyBytes = pubkeyBytes,
            authToken = json.optString("authToken", ""),
            walletUriBase = walletUriBase,
            walletPackage = walletPackage,
            walletType = json.optInt("walletType", WalletRegistry.walletType(walletPackage, walletUriBase)),
            accountLabel = json.optString("accountLabel", ""),
            cluster = AgentCluster.fromId(json.optString("cluster", "devnet")),
            timestampUnixSeconds = json.optLong("timestampUnixSeconds", 0L),
            authenticated = json.optBoolean("authenticated", false),
            capabilitiesCsv = json.optString("capabilitiesCsv", ""),
        )
    }
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
