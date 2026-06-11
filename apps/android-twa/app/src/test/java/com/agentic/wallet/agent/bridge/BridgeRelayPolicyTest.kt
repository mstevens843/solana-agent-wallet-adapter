package com.agentic.wallet.agent.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeRelayPolicyTest {
    @Test
    fun allowsThePinnedRelayHostAndSubdomains() {
        assertTrue(BridgeRelayPolicy.isAllowedRelay("https://agentic-signer.com"))
        assertTrue(BridgeRelayPolicy.isAllowedRelay("https://agentic-signer.com/api/bridge-pair/x/claim"))
        assertTrue(BridgeRelayPolicy.isAllowedRelay("https://relay.agentic-signer.com"))
    }

    @Test
    fun rejectsArbitraryAndCleartextHosts() {
        // The cert-pin only protects the known host; a QR pointing elsewhere must be refused.
        assertFalse(BridgeRelayPolicy.isAllowedRelay("https://evil.com"))
        assertFalse(BridgeRelayPolicy.isAllowedRelay("https://agentic-signer.com.evil.com"))
        assertFalse(BridgeRelayPolicy.isAllowedRelay("http://agentic-signer.com")) // not https
        assertFalse(BridgeRelayPolicy.isAllowedRelay("not a url"))
        assertFalse(BridgeRelayPolicy.isAllowedRelay(""))
        assertFalse(BridgeRelayPolicy.isAllowedRelay(null))
    }
}
