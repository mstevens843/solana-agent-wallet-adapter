package com.agentic.wallet.agent.bridge

import com.agentic.wallet.agent.provider.HttpResponse
import com.agentic.wallet.agent.provider.ProviderErrorCodes
import com.agentic.wallet.agent.provider.ProviderHttpException
import com.agentic.wallet.mwa.AgentMwaLog
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.security.MessageDigest

/** Pairing credentials stored after a successful QR claim. The relay base URL comes from the QR
 *  (validated against the app's pinned relay host); the deviceBearer authenticates AI calls. */
internal data class BridgePairing(
    val relayBaseUrl: String,
    val pairUuid: String,
    val deviceBearer: String,
    val e2ee: BridgeE2eeSession? = null,
)

/** Supplies the current pairing (or null when the phone isn't paired). Backed by
 *  [BridgePairingStore] in production; a lambda in tests. */
internal fun interface BridgePairingSource {
    fun current(): BridgePairing?
}

/**
 * Phone-side client for the "use your ChatGPT/Claude plan from your computer" relay. The phone
 * submits an allowlisted bridge-AI request to the relay and polls for the desktop bridge's
 * result (the desktop runs the actual subscription connector CLI under the user's own session).
 *
 * All relay errors surface as [ProviderHttpException] so the Device Agent executor classifies them
 * the same way it does on-device provider failures.
 */
internal class BridgeAiClient(
    private val transport: BridgeRelayTransport,
    private val pairingSource: BridgePairingSource,
    private val pollIntervalMs: Long = 1500,
    // Must outlive the relay's in-flight lease (10 min) which itself outlives the desktop connector
    // budget, so the phone never gives up while the desktop is still running (orphaned, wasted plan).
    // Invariant: phoneDeadline >= relayLease >= desktopConnectorTimeout. Most runs finish in seconds.
    private val requestTimeoutMs: Long = 600_000,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val clientNonceFactory: () -> String = { BridgeE2ee.randomClientNonce() },
) {
    /** Exchange a one-time pair token for a long-lived device bearer. */
    suspend fun claim(
        relayBaseUrl: String,
        pairUuid: String,
        pairToken: String,
        e2eeQr: BridgeE2eeQrPayload? = null,
    ): BridgeClaimResult {
        val tag = tagFor(pairUuid)
        AgentMwaLog.info("BridgeAiClient", "claim", "START", "claiming pairing", mapOf("tag" to tag))
        val url = "${stripTrailingSlash(relayBaseUrl)}/api/bridge-pair/$pairUuid/claim"
        val preparedE2ee = try {
            e2eeQr?.let { BridgeE2ee.prepareClaim(pairUuid, it) }
        } catch (err: Throwable) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "Pairing QR uses an unsupported encrypted payload format.")
        }
        val claimBody = JSONObject().put("pairToken", pairToken)
        if (preparedE2ee != null) claimBody.put("e2ee", preparedE2ee.claimJson)
        val response = transport.request(
            method = "POST",
            url = url,
            headers = emptyMap(),
            body = claimBody.toString(),
        )
        if (response.status !in 200..299) {
            AgentMwaLog.warn("BridgeAiClient", "claim", "REJECT", "pairing rejected", mapOf("tag" to tag, "status" to response.status))
            throw ProviderHttpException(mapRelayStatus(response.status), claimErrorMessage(response))
        }
        val bearer = parseJson(response.body)?.optString("deviceBearer", "").orEmpty()
        if (bearer.isBlank()) {
            AgentMwaLog.warn("BridgeAiClient", "claim", "FAIL", "no device token in response", mapOf("tag" to tag, "status" to response.status))
            throw ProviderHttpException(ProviderErrorCodes.INVALID_RESPONSE, "Pairing succeeded but returned no device token.")
        }
        AgentMwaLog.info("BridgeAiClient", "claim", "OK", "paired", mapOf("tag" to tag))
        return BridgeClaimResult(deviceBearer = bearer, e2ee = preparedE2ee?.session)
    }

    /** Submit a bridge-AI request and block until the desktop returns its result (or times out).
     *  Returns the desktop bridge's response JSON verbatim (the canonical bridge AI response). */
    suspend fun runForward(path: String, body: JSONObject): JSONObject {
        val pairing = pairingSource.current()
            ?: run {
                AgentMwaLog.warn("BridgeAiClient", "runForward", "UNPAIRED", "no pairing for $path", emptyMap())
                throw ProviderHttpException(
                    ProviderErrorCodes.INVALID_CONFIG,
                    "This phone isn't paired to a computer. Open the desktop app, choose \"Pair a phone\", and scan the QR.",
                )
            }
        val tag = tagFor(pairing.pairUuid)
        val startedAt = now()
        val bodyStr = body.toString()
        // Fail fast with an actionable message instead of an opaque relay 413.
        if (bodyStr.length > MAX_FORWARD_BODY_CHARS) {
            AgentMwaLog.warn("BridgeAiClient", "runForward", "TOO_LARGE", "forward body exceeds cap", mapOf("tag" to tag, "path" to path, "bodyBytes" to bodyStr.length))
            throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "This request is too large to send to your paired computer. Try a shorter prompt.")
        }
        // Preflight: if the desktop isn't currently polling the relay, fail fast (seconds) instead of
        // pending the full timeout (~10 min). We only check BEFORE enqueue — once a request is picked
        // up, the desktop's poll loop can be busy running a connector and legitimately stops
        // heartbeating, so a mid-run check would false-positive. A status() blip is non-fatal (proceed).
        val live = try {
            status()
        } catch (_: Throwable) {
            null
        }
        if (live != null && live.paired && !live.desktopOnline) {
            AgentMwaLog.warn("BridgeAiClient", "runForward", "DESKTOP_OFFLINE", "desktop not polling relay", mapOf("tag" to tag, "path" to path))
            throw ProviderHttpException(
                ProviderErrorCodes.UPSTREAM,
                "Your computer isn't connected right now. Open the Agentic desktop app (and keep it awake), then try again.",
            )
        }
        // The `bodyPayloadJson` key matches AgentMwaLog.isDebugOnlyValueKey (endsWith "payloadjson"),
        // so the exact forwarded payload is captured ONLY in debug builds — release shows [debug-only].
        AgentMwaLog.info(
            "BridgeAiClient", "runForward", "FORWARD", "submitting $path",
            mapOf("tag" to tag, "path" to path, "bodyBytes" to bodyStr.length, "bodyPayloadJson" to bodyStr),
        )
        val forwarded = forward(pairing, path, body)
        AgentMwaLog.info("BridgeAiClient", "runForward", "ENQUEUED", "request accepted", mapOf("tag" to tag, "requestId" to forwarded.requestId, "path" to path))
        val deadline = now() + requestTimeoutMs
        var polls = 0
        while (now() < deadline) {
            sleep(pollIntervalMs)
            polls += 1
            val result = try {
                pollResult(pairing, forwarded.requestId, path, forwarded.clientNonce)
            } catch (e: ProviderHttpException) {
                // Transient transport blip (e.g. a dropped 200 body) — keep polling. The relay holds a
                // resolved result for a grace window, so a re-poll recovers a run the desktop already
                // completed/metered instead of failing it. Terminal codes (auth/config) still propagate.
                if (e.code == ProviderErrorCodes.NETWORK || e.code == ProviderErrorCodes.TIMEOUT) {
                    AgentMwaLog.info("BridgeAiClient", "runForward", "POLL_RETRY", "transient poll failure", mapOf("tag" to tag, "requestId" to forwarded.requestId, "code" to e.code))
                    continue
                }
                throw e
            }
            if (result.resolved) {
                val payload = result.payload ?: JSONObject()
                // The desktop relays a connector failure as an { error } envelope (same shape the
                // bridge streams). Re-raise it so the WebView shows the real connector error.
                val error = payload.opt("error")
                if (error is String && error.isNotBlank()) {
                    AgentMwaLog.warn(
                        "BridgeAiClient", "runForward", "DESKTOP_ERROR", error,
                        mapOf("tag" to tag, "requestId" to forwarded.requestId, "path" to path, "elapsedMs" to now() - startedAt, "polls" to polls),
                    )
                    throw ProviderHttpException(ProviderErrorCodes.UPSTREAM, error)
                }
                AgentMwaLog.info(
                    "BridgeAiClient", "runForward", "RESOLVED", "desktop responded",
                    mapOf(
                        "tag" to tag, "requestId" to forwarded.requestId, "path" to path,
                        "elapsedMs" to now() - startedAt, "polls" to polls,
                        "responseBytes" to payload.toString().length, "response" to payload.toString(),
                    ),
                )
                return payload
            }
        }
        AgentMwaLog.warn(
            "BridgeAiClient", "runForward", "TIMEOUT", "desktop did not respond",
            mapOf("tag" to tag, "requestId" to forwarded.requestId, "path" to path, "elapsedMs" to now() - startedAt, "polls" to polls),
        )
        throw ProviderHttpException(
            ProviderErrorCodes.TIMEOUT,
            "Your computer didn't respond in time. Make sure it's awake, the desktop app is running, and the connector is signed in.",
        )
    }

    /** Lightweight health probe — is the relay session live and the desktop currently polling? */
    suspend fun status(): BridgeStatus {
        val pairing = pairingSource.current() ?: return BridgeStatus(paired = false, desktopOnline = false)
        val url = "${stripTrailingSlash(pairing.relayBaseUrl)}/api/bridge-ai/${pairing.pairUuid}/status"
        val response = transport.request("GET", url, bearerHeaders(pairing), null)
        if (response.status == 404) return BridgeStatus(paired = false, desktopOnline = false)
        if (response.status !in 200..299) {
            throw ProviderHttpException(mapRelayStatus(response.status), "Bridge relay status check failed (HTTP ${response.status}).")
        }
        val json = parseJson(response.body) ?: JSONObject()
        return BridgeStatus(paired = json.optBoolean("paired", false), desktopOnline = json.optBoolean("desktopOnline", false))
    }

    suspend fun unpair(pairing: BridgePairing? = pairingSource.current()) {
        val activePairing = pairing ?: return
        val url = "${stripTrailingSlash(activePairing.relayBaseUrl)}/api/bridge-ai/${activePairing.pairUuid}/unpair"
        val response = transport.request("POST", url, bearerHeaders(activePairing), null)
        if (response.status in 200..299 || response.status == 401 || response.status == 403 || response.status == 404) return
        throw ProviderHttpException(mapRelayStatus(response.status), "Bridge relay unpair failed (HTTP ${response.status}).")
    }

    private suspend fun forward(pairing: BridgePairing, path: String, body: JSONObject): ForwardedRequest {
        val url = "${stripTrailingSlash(pairing.relayBaseUrl)}/api/bridge-ai/${pairing.pairUuid}/forward"
        var clientNonce: String? = null
        val outboundBody = pairing.e2ee?.let {
            val nonce = clientNonceFactory()
            clientNonce = nonce
            BridgeE2ee.encrypt(
                it,
                JSONObject()
                    .put("v", 2)
                    .put("path", path)
                    .put("clientNonce", nonce)
                    .put("body", body),
            )
        } ?: body
        val payload = JSONObject().put("path", path).put("body", outboundBody)
        val payloadString = payload.toString()
        if (payloadString.length > MAX_FORWARD_BODY_CHARS) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_CONFIG, "This request is too large to send to your paired computer. Try a shorter prompt.")
        }
        val response = transport.request("POST", url, bearerHeaders(pairing), payloadString)
        if (response.status !in 200..299) {
            throw ProviderHttpException(mapRelayStatus(response.status), "Bridge relay rejected the request (HTTP ${response.status}).")
        }
        val requestId = parseJson(response.body)?.optString("requestId", "").orEmpty()
        if (requestId.isBlank()) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_RESPONSE, "Bridge relay did not return a request id.")
        }
        return ForwardedRequest(requestId = requestId, clientNonce = clientNonce)
    }

    private suspend fun pollResult(pairing: BridgePairing, requestId: String, path: String, clientNonce: String?): PollOutcome {
        val url = "${stripTrailingSlash(pairing.relayBaseUrl)}/api/bridge-ai/${pairing.pairUuid}/result/$requestId"
        val response = transport.request("GET", url, bearerHeaders(pairing), null)
        if (response.status !in 200..299) {
            throw ProviderHttpException(mapRelayStatus(response.status), "Bridge relay result poll failed (HTTP ${response.status}).")
        }
        val json = parseJson(response.body) ?: return PollOutcome(resolved = false, payload = null)
        val status = json.optString("status", "pending")
        return if (status == "resolved") {
            PollOutcome(resolved = true, payload = decodeResult(pairing, path, requestId, clientNonce, json.optJSONObject("result")))
        } else {
            PollOutcome(resolved = false, payload = null)
        }
    }

    private fun decodeResult(pairing: BridgePairing, path: String, requestId: String, clientNonce: String?, result: JSONObject?): JSONObject {
        val payload = result ?: return JSONObject()
        val e2ee = pairing.e2ee ?: return payload
        val decrypted = try {
            BridgeE2ee.decrypt(e2ee, payload)
        } catch (_: Throwable) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_RESPONSE, "Encrypted bridge response could not be read.")
        }
        if (decrypted.optString("path", "") != path) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_RESPONSE, "Encrypted bridge response did not match the request.")
        }
        if (decrypted.optInt("v", 0) != 2 ||
            decrypted.optString("requestId", "") != requestId ||
            decrypted.optString("clientNonce", "") != (clientNonce ?: "")
        ) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_RESPONSE, "Encrypted bridge response did not match the request.")
        }
        return decrypted.optJSONObject("result") ?: JSONObject()
    }

    private fun bearerHeaders(pairing: BridgePairing): Map<String, String> =
        mapOf("Authorization" to "Bearer ${pairing.deviceBearer}")

    private fun claimErrorMessage(response: HttpResponse): String = when (response.status) {
        400 -> when (parseJson(response.body)?.optString("error", "")) {
            "e2ee_required" -> "This pairing QR requires encrypted payload setup. Update the app if needed, then generate a fresh QR on your computer."
            else -> "Pairing QR is not compatible. Generate a fresh QR on your computer and try again."
        }
        403 -> "Pairing code is invalid. Generate a fresh QR on your computer and scan again."
        409 -> "This pairing code was already used. Generate a fresh QR on your computer."
        410 -> "Pairing code expired. Generate a fresh QR on your computer and scan within a minute."
        else -> "Pairing failed (HTTP ${response.status}). Generate a fresh QR on your computer and try again."
    }

    internal data class BridgeStatus(val paired: Boolean, val desktopOnline: Boolean)

    internal data class BridgeClaimResult(val deviceBearer: String, val e2ee: BridgeE2eeSession?)

    private data class ForwardedRequest(val requestId: String, val clientNonce: String?)

    private data class PollOutcome(val resolved: Boolean, val payload: JSONObject?)

    private companion object {
        // Best-effort client guard below the relay's 1 MB body cap (leaves headroom for the
        // {path, body} wrapper); the relay cap is the hard backstop.
        const val MAX_FORWARD_BODY_CHARS = 950_000

        /** Correlation id shared across phone/relay/desktop: first 8 hex of sha256(pairUuid). Never
         *  reveals the uuid (a bearer-grade secret) yet lines up logs across all three hops. */
        fun tagFor(uuid: String): String =
            MessageDigest.getInstance("SHA-256").digest(uuid.toByteArray(Charsets.UTF_8))
                .take(4).joinToString("") { "%02x".format(it.toInt() and 0xff) }

        fun stripTrailingSlash(value: String): String = value.trimEnd('/')

        fun parseJson(body: String): JSONObject? = try {
            if (body.isBlank()) null else JSONObject(body)
        } catch (_: Throwable) {
            null
        }

        fun mapRelayStatus(status: Int): String = when (status) {
            401, 403 -> ProviderErrorCodes.AUTH
            404, 410 -> ProviderErrorCodes.INVALID_CONFIG
            408, 504 -> ProviderErrorCodes.TIMEOUT
            429 -> ProviderErrorCodes.RATE_LIMITED
            in 500..599 -> ProviderErrorCodes.UPSTREAM
            else -> ProviderErrorCodes.INVALID_RESPONSE
        }
    }
}
