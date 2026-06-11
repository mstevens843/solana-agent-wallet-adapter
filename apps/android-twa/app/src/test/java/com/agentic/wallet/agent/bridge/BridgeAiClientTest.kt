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
        )
    }

    @Test
    fun claimReturnsDeviceBearer() = runBlocking {
        val transport = FakeBridgeRelayTransport().apply {
            queueResponse(200, """{"status":"paired","deviceBearer":"new-bearer-xyz"}""")
        }
        val bearer = client(transport).claim(pairing.relayBaseUrl, pairing.pairUuid, "one-time-token")
        assertEquals("new-bearer-xyz", bearer)
        val call = transport.calls.single()
        assertEquals("POST", call.method)
        assertEquals("https://agentic-signer.com/api/bridge-pair/${pairing.pairUuid}/claim", call.url)
        assertEquals("one-time-token", JSONObject(call.body!!).getString("pairToken"))
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
}
