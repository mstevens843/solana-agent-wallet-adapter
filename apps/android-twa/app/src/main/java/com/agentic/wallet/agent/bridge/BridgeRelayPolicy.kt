package com.agentic.wallet.agent.bridge

import java.net.URI

/**
 * Security guard for the relay URL carried in a scanned pairing QR.
 *
 * A scanned QR could encode `relay:"https://evil.com"` and pair the phone against an attacker's relay
 * over ordinary TLS, so we reject any relay whose host isn't on this allowlist BEFORE claiming a
 * pairing. NOTE: certificate pinning of the allowlisted host is deferred GA hardening (no
 * network_security_config.xml ships yet, needs the SPKI hash) — until then this allowlist + HTTPS is
 * the transport posture. Keep the allowlist in lockstep with the eventual pin-set.
 */
internal object BridgeRelayPolicy {
    /** Hosts the app trusts as relays (to be pinned at GA). Subdomains of these are accepted. */
    val ALLOWED_RELAY_HOSTS: Set<String> = setOf("agentic-signer.com")

    fun isAllowedRelay(url: String?): Boolean {
        val trimmed = url?.trim().orEmpty()
        if (trimmed.isEmpty()) return false
        val uri = try {
            URI(trimmed)
        } catch (_: Throwable) {
            return false
        }
        if (uri.scheme?.equals("https", ignoreCase = true) != true) return false
        val host = uri.host?.lowercase() ?: return false
        return ALLOWED_RELAY_HOSTS.any { allowed -> host == allowed || host.endsWith(".$allowed") }
    }
}
