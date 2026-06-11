package com.agentic.wallet.agent.bridge

import com.agentic.wallet.NativeSecureStore

/**
 * Persists the phone↔desktop pairing in the encrypted [NativeSecureStore] (Android Keystore +
 * AES-GCM). The one-time pair token from the QR is never persisted. v2 pairings also store derived
 * payload-encryption keys; v1 pairings simply leave those fields empty.
 */
internal class BridgePairingStore(
    private val secureStore: NativeSecureStore,
) : BridgePairingSource {
    override fun current(): BridgePairing? {
        val relay = secureStore.get(KEY_RELAY_URL) ?: return null
        val uuid = secureStore.get(KEY_PAIR_UUID) ?: return null
        val bearer = secureStore.get(KEY_DEVICE_TOKEN) ?: return null
        // Defense in depth: never hand back a pairing whose relay host isn't pinned/allowlisted
        // (e.g. if a prior build stored one, or the value was tampered with on disk).
        if (!BridgeRelayPolicy.isAllowedRelay(relay)) return null
        val e2eeRequired = secureStore.get(KEY_E2EE_REQUIRED) == "1"
        val hasE2eeState = hasAnyE2eeState()
        val e2ee = readE2eeSession()
        if ((e2eeRequired || hasE2eeState) && e2ee == null) {
            // Do not silently downgrade a v2 pairing to plaintext if encrypted payload keys were
            // partially lost/corrupted. Clear the unusable pairing and force a fresh QR scan.
            clear()
            return null
        }
        return BridgePairing(relayBaseUrl = relay, pairUuid = uuid, deviceBearer = bearer, e2ee = e2ee)
    }

    fun save(pairing: BridgePairing) {
        secureStore.set(KEY_RELAY_URL, pairing.relayBaseUrl)
        secureStore.set(KEY_PAIR_UUID, pairing.pairUuid)
        secureStore.set(KEY_DEVICE_TOKEN, pairing.deviceBearer)
        val e2ee = pairing.e2ee
        if (e2ee == null) {
            clearE2ee()
        } else {
            secureStore.set(KEY_E2EE_REQUIRED, "1")
            secureStore.set(KEY_E2EE_ALG, e2ee.alg)
            secureStore.set(KEY_E2EE_REQUEST_KEY, BridgeE2ee.base64UrlEncode(e2ee.requestKey))
            secureStore.set(KEY_E2EE_RESPONSE_KEY, BridgeE2ee.base64UrlEncode(e2ee.responseKey))
        }
    }

    fun clear() {
        secureStore.remove(KEY_RELAY_URL)
        secureStore.remove(KEY_PAIR_UUID)
        secureStore.remove(KEY_DEVICE_TOKEN)
        clearE2ee()
    }

    fun isPaired(): Boolean = current() != null

    private fun readE2eeSession(): BridgeE2eeSession? {
        val alg = secureStore.get(KEY_E2EE_ALG)
        val requestKey = secureStore.get(KEY_E2EE_REQUEST_KEY)
        val responseKey = secureStore.get(KEY_E2EE_RESPONSE_KEY)
        if (alg == null && requestKey == null && responseKey == null) return null
        if (alg == null || requestKey == null || responseKey == null) return null
        if (alg != BRIDGE_E2EE_PAIRING_ALG) return null
        return try {
            val requestBytes = BridgeE2ee.base64UrlDecode(requestKey)
            val responseBytes = BridgeE2ee.base64UrlDecode(responseKey)
            if (requestBytes.size != 32 || responseBytes.size != 32) return null
            BridgeE2eeSession(
                alg = alg,
                requestKey = requestBytes,
                responseKey = responseBytes,
            )
        } catch (_: Throwable) {
            null
        }
    }

    private fun hasAnyE2eeState(): Boolean =
        secureStore.get(KEY_E2EE_REQUIRED) != null ||
            secureStore.get(KEY_E2EE_ALG) != null ||
            secureStore.get(KEY_E2EE_REQUEST_KEY) != null ||
            secureStore.get(KEY_E2EE_RESPONSE_KEY) != null

    private fun clearE2ee() {
        secureStore.remove(KEY_E2EE_REQUIRED)
        secureStore.remove(KEY_E2EE_ALG)
        secureStore.remove(KEY_E2EE_REQUEST_KEY)
        secureStore.remove(KEY_E2EE_RESPONSE_KEY)
    }

    companion object {
        const val KEY_RELAY_URL = "bridge_relay_url"
        const val KEY_PAIR_UUID = "bridge_pair_uuid"
        const val KEY_DEVICE_TOKEN = "bridge_device_token"
        const val KEY_E2EE_REQUIRED = "bridge_e2ee_required"
        const val KEY_E2EE_ALG = "bridge_e2ee_alg"
        const val KEY_E2EE_REQUEST_KEY = "bridge_e2ee_request_key"
        const val KEY_E2EE_RESPONSE_KEY = "bridge_e2ee_response_key"
    }
}
