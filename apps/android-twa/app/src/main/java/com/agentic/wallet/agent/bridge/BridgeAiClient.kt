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
    private val requestTimeoutMs: Long = 180_000,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    /** Exchange a one-time pair token for a long-lived device bearer. Returns the bearer. */
    suspend fun claim(relayBaseUrl: String, pairUuid: String, pairToken: String): String {
        val tag = tagFor(pairUuid)
        AgentMwaLog.info("BridgeAiClient", "claim", "START", "claiming pairing", mapOf("tag" to tag))
        val url = "${stripTrailingSlash(relayBaseUrl)}/api/bridge-pair/$pairUuid/claim"
        val response = transport.request(
            method = "POST",
            url = url,
            headers = emptyMap(),
            body = JSONObject().put("pairToken", pairToken).toString(),
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
        return bearer
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
        // `bodyJson` is gated to DEBUG builds by AgentMwaLog (release shows [debug-only]), so the
        // exact forwarded payload is captured in a debug build without ever leaking in release.
        AgentMwaLog.info(
            "BridgeAiClient", "runForward", "FORWARD", "submitting $path",
            mapOf("tag" to tag, "path" to path, "bodyBytes" to body.toString().length, "bodyJson" to body.toString()),
        )
        val requestId = forward(pairing, path, body)
        AgentMwaLog.info("BridgeAiClient", "runForward", "ENQUEUED", "request accepted", mapOf("tag" to tag, "requestId" to requestId, "path" to path))
        val deadline = now() + requestTimeoutMs
        var polls = 0
        while (now() < deadline) {
            sleep(pollIntervalMs)
            polls += 1
            val result = pollResult(pairing, requestId)
            if (result.resolved) {
                val payload = result.payload ?: JSONObject()
                // The desktop relays a connector failure as an { error } envelope (same shape the
                // bridge streams). Re-raise it so the WebView shows the real connector error.
                val error = payload.opt("error")
                if (error is String && error.isNotBlank()) {
                    AgentMwaLog.warn(
                        "BridgeAiClient", "runForward", "DESKTOP_ERROR", error,
                        mapOf("tag" to tag, "requestId" to requestId, "path" to path, "elapsedMs" to now() - startedAt, "polls" to polls),
                    )
                    throw ProviderHttpException(ProviderErrorCodes.UPSTREAM, error)
                }
                AgentMwaLog.info(
                    "BridgeAiClient", "runForward", "RESOLVED", "desktop responded",
                    mapOf(
                        "tag" to tag, "requestId" to requestId, "path" to path,
                        "elapsedMs" to now() - startedAt, "polls" to polls,
                        "responseBytes" to payload.toString().length, "response" to payload.toString(),
                    ),
                )
                return payload
            }
        }
        AgentMwaLog.warn(
            "BridgeAiClient", "runForward", "TIMEOUT", "desktop did not respond",
            mapOf("tag" to tag, "requestId" to requestId, "path" to path, "elapsedMs" to now() - startedAt, "polls" to polls),
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

    private suspend fun forward(pairing: BridgePairing, path: String, body: JSONObject): String {
        val url = "${stripTrailingSlash(pairing.relayBaseUrl)}/api/bridge-ai/${pairing.pairUuid}/forward"
        val payload = JSONObject().put("path", path).put("body", body)
        val response = transport.request("POST", url, bearerHeaders(pairing), payload.toString())
        if (response.status !in 200..299) {
            throw ProviderHttpException(mapRelayStatus(response.status), "Bridge relay rejected the request (HTTP ${response.status}).")
        }
        val requestId = parseJson(response.body)?.optString("requestId", "").orEmpty()
        if (requestId.isBlank()) {
            throw ProviderHttpException(ProviderErrorCodes.INVALID_RESPONSE, "Bridge relay did not return a request id.")
        }
        return requestId
    }

    private suspend fun pollResult(pairing: BridgePairing, requestId: String): PollOutcome {
        val url = "${stripTrailingSlash(pairing.relayBaseUrl)}/api/bridge-ai/${pairing.pairUuid}/result/$requestId"
        val response = transport.request("GET", url, bearerHeaders(pairing), null)
        if (response.status !in 200..299) {
            throw ProviderHttpException(mapRelayStatus(response.status), "Bridge relay result poll failed (HTTP ${response.status}).")
        }
        val json = parseJson(response.body) ?: return PollOutcome(resolved = false, payload = null)
        val status = json.optString("status", "pending")
        return if (status == "resolved") {
            PollOutcome(resolved = true, payload = json.optJSONObject("result"))
        } else {
            PollOutcome(resolved = false, payload = null)
        }
    }

    private fun bearerHeaders(pairing: BridgePairing): Map<String, String> =
        mapOf("Authorization" to "Bearer ${pairing.deviceBearer}")

    private fun claimErrorMessage(response: HttpResponse): String = when (response.status) {
        403 -> "Pairing code is invalid. Generate a fresh QR on your computer and scan again."
        409 -> "This pairing code was already used. Generate a fresh QR on your computer."
        410 -> "Pairing code expired. Generate a fresh QR on your computer and scan within a minute."
        else -> "Pairing failed (HTTP ${response.status}). Generate a fresh QR on your computer and try again."
    }

    internal data class BridgeStatus(val paired: Boolean, val desktopOnline: Boolean)

    private data class PollOutcome(val resolved: Boolean, val payload: JSONObject?)

    private companion object {
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
