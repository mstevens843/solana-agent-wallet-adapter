package com.agentic.wallet.agent.runtime

import org.json.JSONObject

interface ProviderExecutor {
    suspend fun generatePlan(config: RuntimeConfig, payload: JSONObject): JSONObject
    suspend fun reviewPlan(config: RuntimeConfig, payload: JSONObject): JSONObject
    suspend fun ask(config: RuntimeConfig, payload: JSONObject): JSONObject
}

class ProviderUnavailableException(val error: RuntimeError) : Exception(error.message)

class ProviderFailedException(val error: RuntimeError) : Exception(error.message)

class ScaffoldProviderExecutor : ProviderExecutor {
    override suspend fun generatePlan(config: RuntimeConfig, payload: JSONObject): JSONObject =
        throw unavailable("generatePlan")

    override suspend fun reviewPlan(config: RuntimeConfig, payload: JSONObject): JSONObject =
        throw unavailable("reviewPlan")

    override suspend fun ask(config: RuntimeConfig, payload: JSONObject): JSONObject =
        throw unavailable("ask")

    private fun unavailable(method: String): ProviderUnavailableException =
        ProviderUnavailableException(
            RuntimeError(
                code = RuntimeErrorCodes.PROVIDER_UNAVAILABLE,
                message = "Device Agent provider execution for $method is not wired in this build.",
            )
        )
}
