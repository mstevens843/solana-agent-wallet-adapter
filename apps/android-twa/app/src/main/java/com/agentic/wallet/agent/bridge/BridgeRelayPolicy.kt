package com.agentic.wallet.agent.bridge

import java.net.URI

/**
 * Security guard for the relay URL carried in a scanned pairing QR.
 *
 * Cert-pinning (res/xml/network_security_config.xml) only protects connections to the KNOWN relay
 * host — it does nothing for an arbitrary host. So a malicious QR encoding `relay:"https://evil.com"`
 * would otherwise let the phone pair against an attacker's relay over ordinary TLS. We therefore
 * reject any relay whose host is not on this allowlist BEFORE claiming a pairing. The allowlist
 * matches the host the app pins; keep the two in lockstep.
 */
internal object BridgeRelayPolicy {
    /** Hosts the app trusts as relays (and pins). Subdomains of these are accepted. */
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
