// Mirrors apps/render-web/src/cloud/policyEnrich.ts + the cloud aiPlanner's
// applyServerSideReviewSafety: when the policy bundle in context.policyBundle
// has at least one failing evaluation (hasBlockingFailure === true) and the LLM
// returned decision === "approve", force-deny.
//
// Necessary on the BYOK device-agent path: the LLM HTTP call happens directly
// from the device with the user's own key, bypassing the cloud's safety net.
// Without this, an LLM hallucination could "approve" something the user's own
// policy rule already failed.
//
// Same logic on the JS-side (apps/browser-demo/src/policyEnrichClient.ts
// enforceBlockingFailure) but defense-in-depth on the native side too.
import Foundation

enum AgenticPolicyBundleEnforcer {
    /// Inspect the LLM review result alongside the request payload. If the
    /// bundle had blocking failures and the LLM returned approve, downgrade to
    /// deny and surface the failing atom ids.
    static func enforce(reviewResult: [String: Any], payload: [String: Any]) -> [String: Any] {
        guard let bundle = extractBundle(from: payload) else { return reviewResult }
        guard let blocking = bundle["hasBlockingFailure"] as? Bool, blocking == true else { return reviewResult }
        // The LLM `text` field contains the JSON it produced; parse it to read decision.
        guard let text = reviewResult["text"] as? String else { return reviewResult }
        guard let textData = text.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: textData, options: []) as? [String: Any] else {
            return reviewResult
        }
        let decision = (parsed["decision"] as? String)?.lowercased()
        guard decision == "approve" else { return reviewResult }

        // Build a corrected decision payload.
        let evaluations = bundle["evaluations"] as? [[String: Any]] ?? []
        let failing = evaluations.filter { ($0["pass"] as? Bool) == false }
        let blockingFactIds = failing.compactMap { $0["atomId"] as? String }
        let firstLabel = (failing.first?["finding"] as? [String: Any])?["label"] as? String
        let reason = firstLabel.map { "User policy bundle failed: \($0)" }
            ?? "User policy bundle has at least one failing rule."

        var corrected = parsed
        corrected["decision"] = "deny"
        corrected["reason"] = reason
        corrected["blockingFactIds"] = blockingFactIds

        // Encode the corrected payload back into the `text` field so downstream
        // consumers (UI rendering, inbox card) see the corrected decision.
        var out = reviewResult
        if let correctedData = try? JSONSerialization.data(withJSONObject: corrected, options: [.sortedKeys]),
           let correctedText = String(data: correctedData, encoding: .utf8) {
            out["text"] = correctedText
        }
        // Also surface the override on the envelope for callers that look at the
        // structured result instead of re-parsing `text`.
        out["safetyOverride"] = [
            "reason": "policy_bundle_blocking_failure",
            "originalDecision": "approve",
            "enforcedDecision": "deny",
            "blockingFactIds": blockingFactIds,
        ]
        AgenticIOSLog.info(
            "AgenticPolicyBundleEnforcer",
            "enforce",
            "OVERRIDE",
            "LLM approve overridden by hasBlockingFailure",
            ["blockingCount": String(blockingFactIds.count)]
        )
        return out
    }

    private static func extractBundle(from payload: [String: Any]) -> [String: Any]? {
        guard let context = payload["context"] as? [String: Any] else { return nil }
        return context["policyBundle"] as? [String: Any]
    }
}
