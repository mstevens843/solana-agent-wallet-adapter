package com.agentic.wallet.agent.provider

import org.json.JSONArray
import org.json.JSONObject

internal fun researchTargetsForPayload(payload: JSONObject): JSONArray? {
    val context = payload.optJSONObject("context") ?: return null
    val targets = context.optJSONArray("researchTargets") ?: return null
    return if (targets.length() > 0) targets else null
}
