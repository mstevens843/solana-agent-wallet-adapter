package com.agentic.wallet.agent.bridge

import com.agentic.wallet.NativeSecureStore

/**
 * Persists the phone↔desktop pairing in the encrypted [NativeSecureStore] (Android Keystore +
 * AES-GCM). Only the long-lived device bearer, the relay URL, and the pairing UUID are stored — the
 * one-time pair token from the QR is never persisted. Doubles as the [BridgePairingSource] the
 * [BridgeAiClient] reads on every call.
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
        return BridgePairing(relayBaseUrl = relay, pairUuid = uuid, deviceBearer = bearer)
    }

    fun save(pairing: BridgePairing) {
        secureStore.set(KEY_RELAY_URL, pairing.relayBaseUrl)
        secureStore.set(KEY_PAIR_UUID, pairing.pairUuid)
        secureStore.set(KEY_DEVICE_TOKEN, pairing.deviceBearer)
    }

    fun clear() {
        secureStore.remove(KEY_RELAY_URL)
        secureStore.remove(KEY_PAIR_UUID)
        secureStore.remove(KEY_DEVICE_TOKEN)
    }

    fun isPaired(): Boolean = current() != null

    companion object {
        const val KEY_RELAY_URL = "bridge_relay_url"
        const val KEY_PAIR_UUID = "bridge_pair_uuid"
        const val KEY_DEVICE_TOKEN = "bridge_device_token"
    }
}
