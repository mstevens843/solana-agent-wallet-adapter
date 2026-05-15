package com.agentic.wallet.agent.provider

import org.json.JSONObject

internal interface DeviceAgentProvider {
    suspend fun generatePlan(payload: JSONObject): JSONObject
    suspend fun reviewPlan(payload: JSONObject): JSONObject
    suspend fun ask(payload: JSONObject): JSONObject
}
