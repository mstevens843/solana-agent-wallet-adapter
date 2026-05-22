import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class PolicyBundleEnforcerTests: XCTestCase {
    private let bundleWithFailure: [String: Any] = [
        "atoms": [
            ["id": "atom.price.sol.gte.80", "type": "price", "rawText": "SOL must be above $80"],
            ["id": "atom.external_price.helium.lt.20", "type": "external_price", "rawText": "helium plan less than $20"],
        ],
        "evaluations": [
            [
                "atomId": "atom.price.sol.gte.80",
                "pass": true,
                "finding": ["label": "SOL price", "value": "$146.50 — jupiter", "tone": "good"],
            ],
            [
                "atomId": "atom.external_price.helium.lt.20",
                "pass": false,
                "finding": ["label": "Helium plan", "value": "$25 — web", "tone": "fail"],
            ],
        ],
        "hasBlockingFailure": true,
        "finishedAt": "2026-05-21T00:00:00.000Z",
    ]

    func testOverridesApproveToDeny() throws {
        let llmText = #"{"decision":"approve","reason":"looks good"}"#
        let result: [String: Any] = ["text": llmText, "provider": "anthropic", "method": "reviewPlan"]
        let payload: [String: Any] = ["context": ["policyBundle": bundleWithFailure]]
        let out = AgenticPolicyBundleEnforcer.enforce(reviewResult: result, payload: payload)

        let correctedText = try XCTUnwrap(out["text"] as? String)
        let data = correctedText.data(using: .utf8)!
        let json = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
        XCTAssertEqual(json?["decision"] as? String, "deny")
        let reason = json?["reason"] as? String ?? ""
        XCTAssertTrue(reason.contains("Helium plan"), "reason should cite failing atom label, got: \(reason)")
        XCTAssertEqual(json?["blockingFactIds"] as? [String], ["atom.external_price.helium.lt.20"])

        let override = try XCTUnwrap(out["safetyOverride"] as? [String: Any])
        XCTAssertEqual(override["reason"] as? String, "policy_bundle_blocking_failure")
        XCTAssertEqual(override["originalDecision"] as? String, "approve")
        XCTAssertEqual(override["enforcedDecision"] as? String, "deny")
    }

    func testPassesThroughDeny() throws {
        let llmText = #"{"decision":"deny","reason":"too risky"}"#
        let result: [String: Any] = ["text": llmText]
        let payload: [String: Any] = ["context": ["policyBundle": bundleWithFailure]]
        let out = AgenticPolicyBundleEnforcer.enforce(reviewResult: result, payload: payload)
        XCTAssertNil(out["safetyOverride"])
        XCTAssertEqual(out["text"] as? String, llmText)
    }

    func testPassesThroughWhenNoBundle() throws {
        let llmText = #"{"decision":"approve","reason":"ok"}"#
        let result: [String: Any] = ["text": llmText]
        let payload: [String: Any] = [:]
        let out = AgenticPolicyBundleEnforcer.enforce(reviewResult: result, payload: payload)
        XCTAssertNil(out["safetyOverride"])
        XCTAssertEqual(out["text"] as? String, llmText)
    }

    func testPassesThroughWhenBundleHasNoFailure() throws {
        var safeBundle = bundleWithFailure
        safeBundle["hasBlockingFailure"] = false
        let llmText = #"{"decision":"approve","reason":"ok"}"#
        let result: [String: Any] = ["text": llmText]
        let payload: [String: Any] = ["context": ["policyBundle": safeBundle]]
        let out = AgenticPolicyBundleEnforcer.enforce(reviewResult: result, payload: payload)
        XCTAssertNil(out["safetyOverride"])
    }

    func testPassesThroughWhenLlmTextNotJson() throws {
        let result: [String: Any] = ["text": "this is not json"]
        let payload: [String: Any] = ["context": ["policyBundle": bundleWithFailure]]
        let out = AgenticPolicyBundleEnforcer.enforce(reviewResult: result, payload: payload)
        XCTAssertNil(out["safetyOverride"])
    }
}
