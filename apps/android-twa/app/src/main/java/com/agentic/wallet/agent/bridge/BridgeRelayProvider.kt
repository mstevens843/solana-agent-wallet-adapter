package com.agentic.wallet.agent.bridge

import com.agentic.wallet.agent.provider.DeviceAgentProvider
import org.json.JSONObject

/**
 * Device Agent provider that runs inference on the user's OWN paired computer instead of on the
 * phone. Each call is forwarded through the relay to the desktop bridge's identical bridge-AI
 * handler, which executes the subscription connector CLI (Codex/Claude) under the user's own
 * legitimate session — so a phone user spends their ChatGPT/Claude plan instead of an API key,
 * without the phone ever holding a vendor token.
 *
 * Returns the desktop bridge's response verbatim (the canonical AiPlan / AiReviewResult / ask
 * result). VERIFICATION (device build): confirm the WebView's device-agent result handling accepts
 * the already-normalized bridge shape the same as the raw on-device-provider shape; if it
 * re-normalizes, a complete object must pass through unchanged.
 */
internal class BridgeRelayProvider(
    private val client: BridgeAiClient,
) : DeviceAgentProvider {
    override suspend fun generatePlan(payload: JSONObject): JSONObject =
        client.runForward("/bridge/ai/generate-plan", payload)

    override suspend fun reviewPlan(payload: JSONObject): JSONObject =
        client.runForward("/bridge/ai/review-plan", payload)

    override suspend fun ask(payload: JSONObject): JSONObject =
        client.runForward("/bridge/ai/ask-about-plan", payload)

    // Paired reviews are already localized by the desktop bridge's aiPlanner
    // (review.localized.source === "model"), so the JS chokepoint skips a localize call here.
    // This forward exists for interface completeness + forward-compat; if the desktop bridge
    // lacks the route the JS side falls back to the cloud endpoint.
    override suspend fun localize(payload: JSONObject): JSONObject =
        client.runForward("/bridge/ai/localize", payload)

    // Native Plan-Connector chat: forward (non-streaming) to the desktop bridge's
    // /bridge/ai/chat, which runs the subscription connector under the user's own plan.
    override suspend fun chat(payload: JSONObject): JSONObject =
        client.runForward("/bridge/ai/chat", payload)
}
