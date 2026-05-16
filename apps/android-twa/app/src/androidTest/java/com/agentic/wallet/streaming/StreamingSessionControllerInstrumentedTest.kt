package com.agentic.wallet.streaming

import android.content.Context
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import com.agentic.wallet.mwa.Base58
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

class StreamingSessionControllerInstrumentedTest {
    @Test
    fun createSessionSignsOneThousandVouchersAndRejectsAfterRevoke() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val controller = StreamingSessionController(context)
        val (secretBase64, publicKey) = deterministicKeypair()
        val sessionId = "android-test-${System.currentTimeMillis()}"
        val metadata = JSONObject()
            .put("ephemeralSignerPubkey", Base58.encode(publicKey))
            .put("capAmount", "100")
            .put("spentAmount", "0")
            .put("remainingAmount", "100")
            .put("tokenSymbol", "USDC")
            .put("expiresAt", "2099-01-01T00:00:00.000Z")

        controller.revokeLocalSession(sessionId)
        try {
            val created = controller.createSession(sessionId, secretBase64, metadata)
            assertEquals(Base58.encode(publicKey), created.getString("ephemeralSignerPubkey"))

            var firstHundredMs = 0L
            val firstHundredStarted = System.nanoTime()
            for (index in 0 until 1_000) {
                val voucher = voucher(sessionId, index)
                val result = controller.signVoucher(sessionId, voucher.toString())
                if (index == 99) {
                    firstHundredMs = (System.nanoTime() - firstHundredStarted) / 1_000_000
                }
                assertEquals("base58", result.getString("signatureEncoding"))
                assertSignature(publicKey, voucher, result.getString("signature"))
            }
            assertTrue("100 voucher signs should complete in <5s, got ${firstHundredMs}ms", firstHundredMs < 5_000L)

            controller.revokeLocalSession(sessionId)
            assertThrows(StreamingSessionException::class.java) {
                controller.signVoucher(sessionId, voucher(sessionId, 1_001).toString())
            }
        } finally {
            controller.revokeLocalSession(sessionId)
        }
    }

    private fun deterministicKeypair(): Pair<String, ByteArray> {
        val seed = ByteArray(32) { index -> (index + 1).toByte() }
        val privateKey = Ed25519PrivateKeyParameters(seed, 0)
        val publicKey = privateKey.generatePublicKey().encoded
        val secret = seed + publicKey
        return Base64.encodeToString(secret, Base64.NO_WRAP) to publicKey
    }

    private fun voucher(sessionId: String, index: Int): JSONObject =
        JSONObject()
            .put("schema", StreamingSessionController.STREAMING_VOUCHER_SCHEMA)
            .put("sessionId", sessionId)
            .put("nonce", "voucher-$index")
            .put("amount", "0.01")
            .put("recipient", "11111111111111111111111111111111")
            .put("issuedAt", "2026-05-16T12:00:00.000Z")

    private fun assertSignature(publicKey: ByteArray, voucher: JSONObject, signatureBase58: String) {
        val signature = Base58.decode(signatureBase58)
        assertEquals(64, signature.size)
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(canonicalize(canonicalVoucherPayload(voucher)).toByteArray(Charsets.UTF_8))
        val verifier = Ed25519Signer()
        verifier.init(false, Ed25519PublicKeyParameters(publicKey, 0))
        verifier.update(digest, 0, digest.size)
        assertTrue(verifier.verifySignature(signature))
    }

    private fun canonicalVoucherPayload(voucher: JSONObject): JSONObject =
        JSONObject()
            .put("schema", voucher.getString("schema"))
            .put("sessionId", voucher.getString("sessionId"))
            .put("nonce", voucher.getString("nonce"))
            .put("amount", voucher.getString("amount"))
            .put("recipient", voucher.getString("recipient"))
            .put("issuedAt", voucher.getString("issuedAt"))

    private fun canonicalize(value: Any?): String {
        if (value == null || value == JSONObject.NULL) return "null"
        return when (value) {
            is Boolean -> if (value) "true" else "false"
            is Number -> value.toString()
            is String -> JSONObject.quote(value)
            is JSONArray -> {
                val entries = (0 until value.length()).joinToString(",") { canonicalize(value.opt(it)) }
                "[$entries]"
            }
            is JSONObject -> {
                val entries = value.keys().asSequence().toList().sorted().joinToString(",") { key ->
                    "${JSONObject.quote(key)}:${canonicalize(value.opt(key))}"
                }
                "{$entries}"
            }
            else -> throw IllegalArgumentException("Unsupported canonical value: ${value.javaClass.simpleName}")
        }
    }
}
