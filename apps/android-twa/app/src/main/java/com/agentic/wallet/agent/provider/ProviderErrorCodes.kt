package com.agentic.wallet.agent.provider

internal object ProviderErrorCodes {
    const val TIMEOUT: String = "provider_timeout"
    const val AUTH: String = "provider_auth"
    const val RATE_LIMITED: String = "provider_rate_limited"
    const val INVALID_RESPONSE: String = "provider_invalid_response"
    const val INVALID_CONFIG: String = "provider_invalid_config"
    const val UPSTREAM: String = "provider_upstream"
    const val NETWORK: String = "provider_network"
}
