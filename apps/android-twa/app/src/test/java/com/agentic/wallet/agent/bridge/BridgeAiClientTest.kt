package com.agentic.wallet.agent.bridge

import com.agentic.wallet.agent.provider.ProviderErrorCodes
import com.agentic.wallet.agent.provider.ProviderHttpException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class BridgeAiClientTest {
    private val pairing = BridgePairing(
        relayBaseUrl = "https://agentic-signer.com",
        pairUuid = "01234567-89ab-4def-8123-456789abcdef",
        deviceBearer = "device-bearer-token",
    )
    private val pairedSource = BridgePairingSource { pairing }

    private fun client(
        transport: FakeBridgeRelayTransport,
        source: BridgePairingSource = pairedSource,
        timeoutMs: Long = 100,
        clientNonce: String = "client-nonce-test-1",
    ): BridgeAiClient {
        // Drive time via the injected sleep so the poll loop is deterministic and instant.
        val clock = longArrayOf(0L)
        return BridgeAiClient(
            transport = transport,
            pairingSource = source,
            pollIntervalMs = 10,
            requestTimeoutMs = timeoutMs,
            now = { clock[0] },
            sleep = { clock[0] += it },
            clientNonceFactory = { clientNonce },
        )
    }

    @Test
    fun claimReturnsDeviceBearer() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"status":"paired","deviceBearer":"new-bearer-xyz"}""")
        }
        val claim = client(transport).claim(pairing.relayBaseUrl, pairing.pairUuid, "one-time-token")
        assertEquals("new-bearer-xyz", claim.deviceBearer)
        assertNull(claim.e2ee)
        val call = transport.calls.single()
        assertEquals("POST", call.method)
        assertEquals("https://agentic-signer.com/api/bridge-pair/${pairing.pairUuid}/claim", call.url)
        assertEquals("one-time-token", JSONObject(call.body!!).getString("pairToken"))
    }

    @Test
    fun claimSendsE2eeProofWhenQrCarriesEncryptedPayloadSetup() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"status":"paired","deviceBearer":"new-bearer-xyz"}""")
        }
        val claim = client(transport).claim(pairing.relayBaseUrl, pairing.pairUuid, "one-time-token", testQrPayload())
        assertEquals("new-bearer-xyz", claim.deviceBearer)
        assertTrue(claim.e2ee != null)
        val body = JSONObject(transport.calls.single().body!!)
        assertEquals("one-time-token", body.getString("pairToken"))
        val e2ee = body.getJSONObject("e2ee")
        assertEquals(BRIDGE_E2EE_PAIRING_ALG, e2ee.getString("alg"))
        assertTrue(e2ee.getString("phonePub").isNotBlank())
        assertTrue(e2ee.getString("proof").isNotBlank())
    }

    @Test
    fun claimMapsExpiredTokenToInvalidConfig() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply { queueResponse(410, """{"error":"pairing_expired"}""") }
        try {
            client(transport).claim(pairing.relayBaseUrl, pairing.pairUuid, "stale")
            fail("expected ProviderHttpException")
        } catch (e: ProviderHttpException) {
            assertEquals(ProviderErrorCodes.INVALID_CONFIG, e.code)
            assertTrue(e.message.contains("expired", ignoreCase = true))
        }
    }

    @Test
    fun runForwardSubmitsThenPollsUntilResolved() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":true}""") // preflight status()
            queueResponse(200, """{"requestId":"req-1","status":"pending"}""") // forward
            queueResponse(200, """{"status":"pending"}""") // poll 1
            queueResponse(200, """{"status":"resolved","result":{"intent":"swap","source":"codex"}}""") // poll 2
        }
        val result = client(transport).runForward("/bridge/ai/generate-plan", JSONObject().put("prompt", "swap 1 SOL"))
        assertEquals("swap", result.getString("intent"))
        assertEquals("codex", result.getString("source"))

        val forwardCall = transport.calls[1] // calls[0] is the preflight status() GET
        assertEquals("POST", forwardCall.method)
        assertEquals("https://agentic-signer.com/api/bridge-ai/${pairing.pairUuid}/forward", forwardCall.url)
        assertEquals("Bearer device-bearer-token", forwardCall.headers["Authorization"])
        val forwardBody = JSONObject(forwardCall.body!!)
        assertEquals("/bridge/ai/generate-plan", forwardBody.getString("path"))
        assertEquals("swap 1 SOL", forwardBody.getJSONObject("body").getString("prompt"))

        val pollCall = transport.calls[2]
        assertEquals("GET", pollCall.method)
        assertEquals("https://agentic-signer.com/api/bridge-ai/${pairing.pairUuid}/result/req-1", pollCall.url)
        assertNull(pollCall.body)
    }

    @Test
    fun runForwardEncryptsBodyAndDecryptsResolvedResultForV2Pairing() = runBlocking {
        val key = ByteArray(32) { idx -> (idx + 1).toByte() }
        val encryptedPairing = pairing.copy(e2ee = BridgeE2eeSession(requestKey = key, responseKey = key))
        val encryptedSource = BridgePairingSource { encryptedPairing }
        val resultEnvelope = BridgeE2ee.encryptForTest(
            key,
            JSONObject()
                .put("v", 2)
                .put("path", "/bridge/ai/generate-plan")
                .put("requestId", "req-e2ee")
                .put("clientNonce", "client-nonce-test-1")
                .put("result", JSONObject().put("intent", "swap").put("source", "codex")),
        )
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":true}""") // preflight status()
            queueResponse(200, """{"requestId":"req-e2ee","status":"pending"}""") // forward
            queueResponse(200, JSONObject().put("status", "resolved").put("result", resultEnvelope).toString()) // poll
        }
        val result = client(transport, source = encryptedSource).runForward(
            "/bridge/ai/generate-plan",
            JSONObject().put("prompt", "swap 1 SOL"),
        )
        assertEquals("swap", result.getString("intent"))
        assertEquals("codex", result.getString("source"))

        val forwardBody = JSONObject(transport.calls[1].body!!)
        assertEquals("/bridge/ai/generate-plan", forwardBody.getString("path"))
        val encryptedBody = forwardBody.getJSONObject("body")
        assertTrue(encryptedBody.has("e2ee"))
        assertTrue(!encryptedBody.toString().contains("swap 1 SOL"))
        val decrypted = BridgeE2ee.decryptRequestForTest(key, encryptedBody)
        assertEquals(2, decrypted.getInt("v"))
        assertEquals("/bridge/ai/generate-plan", decrypted.getString("path"))
        assertEquals("client-nonce-test-1", decrypted.getString("clientNonce"))
        assertEquals("swap 1 SOL", decrypted.getJSONObject("body").getString("prompt"))
    }

    @Test
    fun runForwardRejectsEncryptedResultForDifferentRequestIdOrNonce() = runBlocking {
        val key = ByteArray(32) { idx -> (idx + 1).toByte() }
        val encryptedPairing = pairing.copy(e2ee = BridgeE2eeSession(requestKey = key, responseKey = key))
        val resultEnvelope = BridgeE2ee.encryptForTest(
            key,
            JSONObject()
                .put("v", 2)
                .put("path", "/bridge/ai/generate-plan")
                .put("requestId", "req-other")
                .put("clientNonce", "client-nonce-test-1")
                .put("result", JSONObject().put("intent", "swap")),
        )
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":true}""")
            queueResponse(200, """{"requestId":"req-e2ee","status":"pending"}""")
            queueResponse(200, JSONObject().put("status", "resolved").put("result", resultEnvelope).toString())
        }
        try {
            client(transport, source = BridgePairingSource { encryptedPairing }).runForward("/bridge/ai/generate-plan", JSONObject())
            fail("expected request binding failure")
        } catch (e: ProviderHttpException) {
            assertEquals(ProviderErrorCodes.INVALID_RESPONSE, e.code)
        }
    }

    @Test
    fun runForwardRejectsMalformedEncryptedResultForV2Pairing() = runBlocking {
        val key = ByteArray(32) { idx -> (idx + 1).toByte() }
        val encryptedPairing = pairing.copy(e2ee = BridgeE2eeSession(requestKey = key, responseKey = key))
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":true}""")
            queueResponse(200, """{"requestId":"req-bad","status":"pending"}""")
            queueResponse(200, """{"status":"resolved","result":{"not":"encrypted"}}""")
        }
        try {
            client(transport, source = BridgePairingSource { encryptedPairing }).runForward("/bridge/ai/generate-plan", JSONObject())
            fail("expected invalid encrypted response")
        } catch (e: ProviderHttpException) {
            assertEquals(ProviderErrorCodes.INVALID_RESPONSE, e.code)
        }
    }

    @Test
    fun runForwardReRaisesDesktopErrorEnvelope() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":true}""") // preflight status()
            queueResponse(200, """{"requestId":"req-2","status":"pending"}""")
            queueResponse(200, """{"status":"resolved","result":{"error":"Codex (ChatGPT plan) CLI not found."}}""")
        }
        try {
            client(transport).runForward("/bridge/ai/review-plan", JSONObject())
            fail("expected ProviderHttpException")
        } catch (e: ProviderHttpException) {
            assertEquals(ProviderErrorCodes.UPSTREAM, e.code)
            assertTrue(e.message.contains("CLI not found"))
        }
    }

    @Test
    fun runForwardFailsFastWhenDesktopOffline() = runBlocking {
        // Preflight status() reports the desktop isn't polling the relay -> fail fast, no forward.
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":false}""")
        }
        try {
            client(transport).runForward("/bridge/ai/generate-plan", JSONObject())
            fail("expected fast-fail")
        } catch (e: ProviderHttpException) {
            assertEquals(ProviderErrorCodes.UPSTREAM, e.code)
            assertTrue(e.message.contains("isn't connected", ignoreCase = true))
        }
        assertEquals("only the preflight status() call, no forward", 1, transport.calls.size)
    }

    @Test
    fun runForwardThrowsWhenNotPaired() = runBlocking {
        val transport = FakeBridgeRelayTransport()
        try {
            client(transport, source = BridgePairingSource { null }).runForward("/bridge/ai/generate-plan", JSONObject())
            fail("expected ProviderHttpException")
        } catch (e: ProviderHttpException) {
            assertEquals(ProviderErrorCodes.INVALID_CONFIG, e.code)
            assertTrue(e.message.contains("paired", ignoreCase = true))
        }
        assertTrue("must not hit the network when unpaired", transport.calls.isEmpty())
    }

    @Test
    fun runForwardTimesOutWhenDesktopNeverResponds() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":true}""") // preflight status()
            queueResponse(200, """{"requestId":"req-3","status":"pending"}""")
            repeat(20) { queueResponse(200, """{"status":"pending"}""") }
        }
        try {
            client(transport, timeoutMs = 100).runForward("/bridge/ai/ask-about-plan", JSONObject())
            fail("expected timeout")
        } catch (e: ProviderHttpException) {
            assertEquals(ProviderErrorCodes.TIMEOUT, e.code)
        }
    }

    @Test
    fun runForwardMapsAuthFailureToAuthCode() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":true}""") // preflight status()
            queueResponse(401, """{"error":"device_auth_failed"}""") // forward
        }
        try {
            client(transport).runForward("/bridge/ai/generate-plan", JSONObject())
            fail("expected auth error")
        } catch (e: ProviderHttpException) {
            assertEquals(ProviderErrorCodes.AUTH, e.code)
        }
    }

    @Test
    fun runForwardRetriesTransientPollBlipThenResolves() = runBlocking {
        // A dropped result-poll (NETWORK) must NOT fail the request — keep polling; the relay holds the
        // resolved result in its grace window. Critically, this must NOT re-dispatch (no double-meter).
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":true}""") // preflight
            queueResponse(200, """{"requestId":"req-x","status":"pending"}""") // forward
            queueFailure(ProviderHttpException(ProviderErrorCodes.NETWORK, "dropped")) // transient poll blip
            queueResponse(200, """{"status":"resolved","result":{"intent":"swap"}}""") // recovered poll
        }
        val result = client(transport).runForward("/bridge/ai/generate-plan", JSONObject())
        assertEquals("swap", result.getString("intent"))
        // Exactly one forward (calls: status, forward, poll-fail, poll-ok).
        assertEquals(1, transport.calls.count { it.method == "POST" && it.url.endsWith("/forward") })
    }

    @Test
    fun runForwardProceedsWhenPreflightStatusThrows() = runBlocking {
        // A status() blip must not block the request — live=null → proceed to forward.
        val transport = FakeBridgeRelayTransport().apply {
            queueFailure(ProviderHttpException(ProviderErrorCodes.NETWORK, "status blip")) // preflight throws
            queueResponse(200, """{"requestId":"req-y","status":"pending"}""") // forward
            queueResponse(200, """{"status":"resolved","result":{"intent":"swap"}}""") // poll
        }
        val result = client(transport).runForward("/bridge/ai/generate-plan", JSONObject())
        assertEquals("swap", result.getString("intent"))
    }

    @Test
    fun statusReportsPairedAndDesktopOnline() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"paired":true,"desktopOnline":true}""")
        }
        val status = client(transport).status()
        assertTrue(status.paired)
        assertTrue(status.desktopOnline)
    }

    @Test
    fun unpairCallsRelayWithDeviceBearer() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"ok":true}""")
        }
        client(transport).unpair(pairing)
        val call = transport.calls.single()
        assertEquals("POST", call.method)
        assertEquals("https://agentic-signer.com/api/bridge-ai/${pairing.pairUuid}/unpair", call.url)
        assertEquals("Bearer device-bearer-token", call.headers["Authorization"])
        assertNull(call.body)
    }

    private fun testQrPayload(): BridgeE2eeQrPayload {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val publicKey = generator.generateKeyPair().public as ECPublicKey
        val rawPublic = byteArrayOf(0x04) + fixed32(publicKey.w.affineX) + fixed32(publicKey.w.affineY)
        return BridgeE2eeQrPayload(
            alg = BRIDGE_E2EE_PAIRING_ALG,
            desktopPub = BridgeE2ee.base64UrlEncode(rawPublic),
            pairSecret = BridgeE2ee.base64UrlEncode(ByteArray(32) { idx -> (idx + 7).toByte() }),
        )
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
