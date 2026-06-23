package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.runtime.ProviderFailedException
import com.agentic.wallet.agent.runtime.RuntimeError
import com.agentic.wallet.agent.runtime.RuntimeErrorCodes
import org.json.JSONObject

internal interface DeviceAgentProvider {
    suspend fun generatePlan(payload: JSONObject): JSONObject
    suspend fun reviewPlan(payload: JSONObject): JSONObject
    suspend fun ask(payload: JSONObject): JSONObject

    /** Translate a finished review's display copy into the user's language (text-in/text-out
     *  like [ask]; returns { "output_text": ... }). */
    suspend fun localize(payload: JSONObject): JSONObject

    /** Native Plan-Connector chat. Only the paired-bridge provider forwards this to the desktop's
     *  /bridge/ai/chat; on-device providers inherit this default and reject it (chat has no
     *  on-device plan/review framing). */
    suspend fun chat(payload: JSONObject): JSONObject =
        throw ProviderFailedException(
            RuntimeError(
                code = RuntimeErrorCodes.PROVIDER_UNAVAILABLE,
                message = "On-device chat is not supported. Connect a Plan Connector on your computer to chat.",
            ),
        )
}
