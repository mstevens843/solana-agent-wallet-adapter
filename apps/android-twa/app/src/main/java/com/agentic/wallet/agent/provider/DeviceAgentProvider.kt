package com.agentic.wallet.agent.provider

import org.json.JSONObject

internal interface DeviceAgentProvider {
    suspend fun generatePlan(payload: JSONObject): JSONObject
    suspend fun reviewPlan(payload: JSONObject): JSONObject
    suspend fun ask(payload: JSONObject): JSONObject

    /** Translate a finished review's display copy into the user's language (text-in/text-out
     *  like [ask]; returns { "output_text": ... }). */
    suspend fun localize(payload: JSONObject): JSONObject
}
