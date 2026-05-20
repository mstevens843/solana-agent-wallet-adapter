package com.agentic.wallet

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.agentic.wallet.mwa.AgentMwaLog
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class NativeSecureStore(context: Context) {
    private val storeDir = File(context.filesDir, "AgenticAndroidSecureStore")
    private val encryptedStoreFile = File(storeDir, "CloudSession.v1.enc")
    private val encryptor = NativeSecureStoreEncryptor()
    private val values = JSONObject()
    private var loaded = false

    @Synchronized
    fun get(key: String): String? {
        ensureLoaded()
        return values.optString(key, "").takeIf { it.isNotBlank() }
    }

    @Synchronized
    fun set(key: String, value: String) {
        ensureLoaded()
        if (value.isBlank()) {
            values.remove(key)
        } else {
            values.put(key, value)
        }
        save()
    }

    @Synchronized
    fun remove(key: String) {
        ensureLoaded()
        values.remove(key)
        save()
    }

    private fun ensureLoaded() {
        if (loaded) return
        loaded = true
        if (!encryptedStoreFile.exists()) {
            AgentMwaLog.info("NativeSecureStore", "load", "SKIP", "secure store missing")
            return
        }
        try {
            val plaintext = encryptor.decrypt(encryptedStoreFile.readText(Charsets.UTF_8))
            val root = JSONObject(plaintext)
            val objectValues = root.optJSONObject("values") ?: JSONObject()
            for (key in objectValues.keys()) {
                values.put(key, objectValues.optString(key, ""))
            }
            AgentMwaLog.info("NativeSecureStore", "load", "DONE", "secure store loaded", mapOf("keys" to values.length()))
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "NativeSecureStore",
                "load",
                "FAIL",
                "secure store could not be read; clearing cloud session token",
                mapOf("class" to err.javaClass.simpleName, "message" to err.message),
            )
            values.remove(CLOUD_SESSION_TOKEN_KEY)
            encryptedStoreFile.delete()
        }
    }

    private fun save() {
        try {
            encryptedStoreFile.parentFile?.mkdirs()
            val root = JSONObject()
                .put("schema", 1)
                .put("values", values)
            val encrypted = encryptor.encrypt("${root.toString(2)}\n")
            encryptedStoreFile.writeText("${encrypted.toString(2)}\n", Charsets.UTF_8)
            AgentMwaLog.info("NativeSecureStore", "save", "DONE", "secure store saved", mapOf("keys" to values.length()))
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "NativeSecureStore",
                "save",
                "FAIL",
                "secure store save failed",
                mapOf("class" to err.javaClass.simpleName, "message" to err.message),
            )
        }
    }

    companion object {
        const val CLOUD_SESSION_TOKEN_KEY = "cloudSessionToken"
        const val DEVICE_AGENT_CONFIG_KEY = "deviceAgentConfig"
        const val REMOTE_CONFIG_KEY = "remoteConfigV1"
    }
}

private class NativeSecureStoreEncryptor {
    fun encrypt(plaintext: String): JSONObject {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return JSONObject()
            .put("schema", 1)
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
        private const val KEY_ALIAS = "AgenticAndroidCloudSessionStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH_BITS = 128
    }
}
