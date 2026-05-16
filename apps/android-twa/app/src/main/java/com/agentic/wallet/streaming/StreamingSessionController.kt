package com.agentic.wallet.streaming

import org.json.JSONObject

/**
 * Phase 0 scaffolding for the on-device streaming-session controller.
 *
 * In Phase 2D this class will:
 *   - Persist per-session ephemeral ed25519 secret keys in Android Keystore.
 *   - Sign voucher payloads in <50ms without WebView roundtrips or per-voucher
 *     MWA approvals (the wallet pre-authorized the session via SPL Token
 *     Approve once, granting the bounded delegate authority).
 *   - Track session liveness (expiry, revocation) so signing fails fast.
 *
 * For now all entry points return a structured `not_implemented` envelope so
 * MainActivity's [com.agentic.wallet.MainActivity.AndroidBridge.streamingRequest]
 * stub can wire to a real controller in Phase 2D without changing call sites.
 */
class StreamingSessionController {
    /**
     * Persist the ephemeral secret key for a session under [sessionId].
     * Phase 2D: writes to Android Keystore, returns success envelope.
     */
    fun createSession(sessionId: String, ephemeralPrivkeyBase64: String): JSONObject {
        return notImplemented("createSession", sessionId)
    }

    /**
     * Sign a canonical voucher payload using the session's ephemeral key.
     * Phase 2D: loads from Keystore, ed25519-signs canonical JSON, returns
     * `{ ok: true, signature: <base58> }`. Latency target <50ms.
     */
    fun signVoucher(sessionId: String, voucherJson: String): JSONObject {
        return notImplemented("signVoucher", sessionId)
    }

    /**
     * Delete the local session key. Idempotent.
     * Phase 2D: removes from Keystore + cancels foreground notification slot.
     */
    fun revokeLocalSession(sessionId: String): JSONObject {
        return notImplemented("revokeLocalSession", sessionId)
    }

    private fun notImplemented(method: String, sessionId: String): JSONObject =
        JSONObject()
            .put("ok", false)
            .put("status", "not_implemented")
            .put("phase", "phase_0_scaffolding")
            .put("method", method)
            .put("sessionId", sessionId)
}
