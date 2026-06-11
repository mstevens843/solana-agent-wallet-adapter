package com.agentic.wallet.agent.bridge

import org.bouncycastle.util.encoders.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal const val BRIDGE_E2EE_PAIRING_ALG = "P256-HKDF-SHA256-A256GCM"
internal const val BRIDGE_E2EE_ENVELOPE_ALG = "A256GCM"

internal data class BridgeE2eeQrPayload(
    val alg: String,
    val desktopPub: String,
    val pairSecret: String,
)

internal data class BridgeE2eeSession(
    val alg: String = BRIDGE_E2EE_PAIRING_ALG,
    val requestKey: ByteArray,
    val responseKey: ByteArray,
)

internal data class BridgeE2eePreparedClaim(
    val claimJson: JSONObject,
    val session: BridgeE2eeSession,
)

internal object BridgeE2ee {
    private val secureRandom = SecureRandom()

    fun parseQr(value: JSONObject?): BridgeE2eeQrPayload? {
        if (value == null) return null
        val alg = value.optString("alg", "").trim()
        val desktopPub = value.optString("desktopPub", "").trim()
        val pairSecret = value.optString("pairSecret", "").trim()
        if (alg.isEmpty() || desktopPub.isEmpty() || pairSecret.isEmpty()) return null
        return BridgeE2eeQrPayload(alg = alg, desktopPub = desktopPub, pairSecret = pairSecret)
    }

    fun prepareClaim(pairUuid: String, qr: BridgeE2eeQrPayload): BridgeE2eePreparedClaim {
        require(qr.alg == BRIDGE_E2EE_PAIRING_ALG) { "unsupported_e2ee_alg" }
        val keyPairGenerator = KeyPairGenerator.getInstance("EC")
        keyPairGenerator.initialize(ECGenParameterSpec("secp256r1"))
        val keyPair = keyPairGenerator.generateKeyPair()
        val phonePublic = keyPair.public as ECPublicKey
        val phonePub = base64UrlEncode(rawPublicKey(phonePublic))
        val desktopPublicKey = publicKeyFromRaw(qr.desktopPub, phonePublic.params)
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(keyPair.private)
        agreement.doPhase(desktopPublicKey, true)
        val sharedSecret = agreement.generateSecret()
        val salt = e2eeSalt(pairUuid, qr.desktopPub, phonePub)
        val proof = e2eeProof(pairUuid, qr.desktopPub, phonePub, qr.pairSecret)
        return BridgeE2eePreparedClaim(
            claimJson = JSONObject()
                .put("alg", BRIDGE_E2EE_PAIRING_ALG)
                .put("phonePub", phonePub)
                .put("proof", proof),
            session = BridgeE2eeSession(
                requestKey = hkdfSha256(sharedSecret, salt, "agentic-bridge-e2ee/request/v1".toByteArray(Charsets.UTF_8), 32),
                responseKey = hkdfSha256(sharedSecret, salt, "agentic-bridge-e2ee/response/v1".toByteArray(Charsets.UTF_8), 32),
            ),
        )
    }

    fun encrypt(session: BridgeE2eeSession, payload: JSONObject): JSONObject {
        val nonce = ByteArray(12)
        secureRandom.nextBytes(nonce)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(session.requestKey, "AES"), GCMParameterSpec(128, nonce))
        val ciphertext = cipher.doFinal(payload.toString().toByteArray(Charsets.UTF_8))
        return JSONObject()
            .put(
                "e2ee",
                JSONObject()
                    .put("v", 2)
                    .put("alg", BRIDGE_E2EE_ENVELOPE_ALG)
                    .put("nonce", base64UrlEncode(nonce))
                    .put("ciphertext", base64UrlEncode(ciphertext)),
            )
    }

    fun decrypt(session: BridgeE2eeSession, envelope: JSONObject): JSONObject {
        val e2ee = envelope.optJSONObject("e2ee") ?: throw IllegalArgumentException("missing_e2ee")
        if (e2ee.optInt("v", 0) != 2 || e2ee.optString("alg") != BRIDGE_E2EE_ENVELOPE_ALG) {
            throw IllegalArgumentException("unsupported_e2ee_envelope")
        }
        val nonce = base64UrlDecode(e2ee.optString("nonce", ""))
        val ciphertext = base64UrlDecode(e2ee.optString("ciphertext", ""))
        if (nonce.size != 12 || ciphertext.size < 17) throw IllegalArgumentException("invalid_e2ee_payload")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(session.responseKey, "AES"), GCMParameterSpec(128, nonce))
        val plaintext = cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
        return JSONObject(plaintext)
    }

    fun encryptForTest(key: ByteArray, payload: JSONObject): JSONObject {
        val session = BridgeE2eeSession(requestKey = key, responseKey = key)
        return encrypt(session, payload)
    }

    fun decryptRequestForTest(key: ByteArray, envelope: JSONObject): JSONObject {
        val session = BridgeE2eeSession(requestKey = key, responseKey = key)
        val e2ee = envelope.getJSONObject("e2ee")
        val nonce = base64UrlDecode(e2ee.getString("nonce"))
        val ciphertext = base64UrlDecode(e2ee.getString("ciphertext"))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(session.requestKey, "AES"), GCMParameterSpec(128, nonce))
        return JSONObject(cipher.doFinal(ciphertext).toString(Charsets.UTF_8))
    }

    fun base64UrlEncode(bytes: ByteArray): String =
        Base64.toBase64String(bytes).replace('+', '-').replace('/', '_').trimEnd('=')

    fun randomClientNonce(): String {
        val bytes = ByteArray(16)
        secureRandom.nextBytes(bytes)
        return base64UrlEncode(bytes)
    }

    fun base64UrlDecode(value: String): ByteArray {
        val normalized = value.replace('-', '+').replace('_', '/')
        val padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
        return Base64.decode(padded)
    }

    private fun e2eeProof(pairUuid: String, desktopPub: String, phonePub: String, pairSecret: String): String =
        base64UrlEncode(hmacSha256(base64UrlDecode(pairSecret), e2eeProofMessage(pairUuid, desktopPub, phonePub).toByteArray(Charsets.UTF_8)))

    private fun e2eeProofMessage(pairUuid: String, desktopPub: String, phonePub: String): String =
        "agentic-bridge-e2ee-proof-v1\n$pairUuid\n$desktopPub\n$phonePub"

    private fun e2eeSalt(pairUuid: String, desktopPub: String, phonePub: String): ByteArray =
        MessageDigest.getInstance("SHA-256")
            .digest("agentic-bridge-e2ee-salt-v1\n$pairUuid\n$desktopPub\n$phonePub".toByteArray(Charsets.UTF_8))

    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmacSha256(salt, ikm)
        var previous = ByteArray(0)
        val okm = ArrayList<Byte>()
        var counter = 1
        while (okm.size < length) {
            val input = previous + info + byteArrayOf(counter.toByte())
            previous = hmacSha256(prk, input)
            okm.addAll(previous.toList())
            counter += 1
        }
        return okm.take(length).toByteArray()
    }

    private fun hmacSha256(key: ByteArray, body: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(body)
    }

    private fun rawPublicKey(key: ECPublicKey): ByteArray =
        byteArrayOf(0x04) + fixed32(key.w.affineX) + fixed32(key.w.affineY)

    private fun publicKeyFromRaw(encoded: String, params: java.security.spec.ECParameterSpec): java.security.PublicKey {
        val raw = base64UrlDecode(encoded)
        require(raw.size == 65 && raw[0] == 0x04.toByte()) { "invalid_desktop_pub" }
        val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params))
    }

    private fun fixed32(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
            else -> ByteArray(32 - raw.size) + raw
        }
    }
}
