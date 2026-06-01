import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class DeviceAgentRuntimeLifecycleTests: XCTestCase {
    func testDispatchContextMarksCompletionOnce() {
        let context = AgenticAgentDispatchContext(
            requestId: "device-agent-test-1",
            method: "reviewPlan",
            provider: NoopAgentProvider(),
            timeoutSeconds: 3600
        ) { _, _ in
            XCTFail("markFinished should not call completion directly")
        }

        XCTAssertTrue(context.markFinished())
        XCTAssertFalse(context.markFinished())
    }

    func testRequestHttpLogMetadataCarriesRequestIdentity() {
        let request = AgenticAgentRequest(
            requestId: "device-agent-test-2",
            method: "reviewPlan",
            systemPrompt: "system",
            userInstruction: "review",
            context: nil,
            payload: ["instruction": "review"],
            payloadBytes: 24,
            config: AgenticAgentRuntimeConfig(
                provider: "anthropic",
                apiFormat: "anthropic",
                model: "claude-opus-4-1",
                baseUrl: nil,
                apiKey: "sk-test",
                walletAddress: nil
            )
        )

        XCTAssertEqual(request.httpLogMetadata(provider: "anthropic", research: true), [
            "requestId": "device-agent-test-2",
            "method": "reviewPlan",
            "provider": "anthropic",
            "model": "claude-opus-4-1",
            "research": "true",
        ])
    }

    func testProviderFactoryRoutesOnlyExplicitNativeProviders() {
        XCTAssertTrue(AgenticAgentProviderFactory.make(for: runtimeConfig(
            provider: "openai",
            apiFormat: "openai-compatible",
            model: "gpt-5"
        )) is AgenticOpenAINativeProvider)

        XCTAssertTrue(AgenticAgentProviderFactory.make(for: runtimeConfig(
            provider: "gemini",
            apiFormat: "openai-compatible",
            model: "gemini-2.5-pro"
        )) is AgenticGeminiProvider)

        XCTAssertTrue(AgenticAgentProviderFactory.make(for: runtimeConfig(
            provider: "openrouter",
            apiFormat: "openai-compatible",
            model: "google/gemini-2.5-pro",
            baseUrl: "https://openrouter.ai/api/v1"
        )) is AgenticOpenAICompatibleProvider)

        XCTAssertTrue(AgenticAgentProviderFactory.make(for: runtimeConfig(
            provider: "custom-openai-compatible",
            apiFormat: "openai-compatible",
            model: "gemini-2.5-flash",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
        )) is AgenticOpenAICompatibleProvider)

        XCTAssertTrue(AgenticAgentProviderFactory.make(for: runtimeConfig(
            provider: "anthropic",
            apiFormat: "anthropic",
            model: "claude-opus-4-1"
        )) is AgenticAnthropicProvider)
    }

    func testBridgeEnvelopeParsesScalarPayloadJsonObject() throws {
        let payload = try AgenticDeviceAgentBridgeEnvelope.parsePayloadJson("""
        {"instruction":"review","context":{"transactionBase64":"abc"}}
        """)

        XCTAssertEqual(payload["instruction"] as? String, "review")
        let context = payload["context"] as? [String: Any]
        XCTAssertEqual(context?["transactionBase64"] as? String, "abc")
    }

    func testBridgeEnvelopeRejectsInvalidPayloadJsonShapes() {
        XCTAssertThrowsError(try AgenticDeviceAgentBridgeEnvelope.parsePayloadJson("[1,2,3]")) { error in
            let err = error as? AgenticAgentError
            XCTAssertEqual(err?.code, "invalid_payload")
            XCTAssertEqual(err?.subcode, "object_expected")
        }
        XCTAssertThrowsError(try AgenticDeviceAgentBridgeEnvelope.parsePayloadJson("{")) { error in
            let err = error as? AgenticAgentError
            XCTAssertEqual(err?.code, "invalid_payload")
            XCTAssertEqual(err?.subcode, "json_parse")
        }
    }

    func testBridgeEnvelopeRequestValidationMatchesAndroidContract() {
        XCTAssertTrue(AgenticDeviceAgentBridgeEnvelope.isValidRequestId("device-agent-test_1:2.3"))
        XCTAssertFalse(AgenticDeviceAgentBridgeEnvelope.isValidRequestId(""))
        XCTAssertFalse(AgenticDeviceAgentBridgeEnvelope.isValidRequestId(String(repeating: "a", count: 161)))
        XCTAssertTrue(AgenticDeviceAgentBridgeEnvelope.isSupportedMethod("reviewPlan"))
        XCTAssertFalse(AgenticDeviceAgentBridgeEnvelope.isSupportedMethod("review_plan"))
        XCTAssertEqual(AgenticDeviceAgentBridgeEnvelope.payloadLimit(for: "configure"), 8_192)
        XCTAssertEqual(AgenticDeviceAgentBridgeEnvelope.payloadLimit(for: "reviewPlan"), 2_000_000)
    }

    func testBridgeEnvelopeBuildsAndroidStyleSuccessAndFailure() {
        let status: [String: Any] = [
            "available": true,
            "enabled": true,
            "configured": true,
            "state": "stopped",
            "runtime": "ios-native",
        ]
        let success = AgenticDeviceAgentBridgeEnvelope.success(
            status: status,
            result: ["decision": "approve"]
        )
        XCTAssertEqual(success["ok"] as? Bool, true)
        XCTAssertEqual((success["result"] as? [String: Any])?["decision"] as? String, "approve")

        let failure = AgenticDeviceAgentBridgeEnvelope.failure(
            status: status,
            error: AgenticAgentError(code: "provider_auth", subcode: "invalid_key", message: "Bad key.")
        )
        XCTAssertEqual(failure["ok"] as? Bool, false)
        let error = failure["error"] as? [String: Any]
        XCTAssertEqual(error?["code"] as? String, "provider_auth")
        XCTAssertEqual(error?["subcode"] as? String, "invalid_key")
    }

    func testResearchFallbackPayloadMarksResearchAttemptCompleted() {
        let payload: [String: Any] = [
            "instruction": "only approve if current price is under $20",
            "research": [
                "needed": true,
                "maxSearches": 9,
            ],
        ]

        let next = AgenticAgentProviderSupport.reviewPayloadAfterResearchAttempt(payload)
        let research = next["research"] as? [String: Any]
        XCTAssertEqual(research?["needed"] as? Bool, false)
        XCTAssertEqual(research?["mode"] as? String, "provided_current_facts")
        XCTAssertEqual(research?["providedEvidence"] as? Bool, true)
        XCTAssertEqual(AgenticAgentProviderSupport.researchMaxUses(payload), 5)
        XCTAssertEqual(AgenticAgentProviderSupport.researchMaxUses(["research": ["maxSearches": 2.8]]), 2)
        XCTAssertEqual(AgenticAgentProviderSupport.researchMaxUses(["research": ["maxSearches": "4"]]), 4)
    }

    func testMalformedReviewNormalizesToNeedsInputContract() {
        let result = AgenticAgentProviderSupport.parseProviderResult(
            method: "reviewPlan",
            provider: "openai",
            text: "not json",
            raw: [:]
        )

        guard case .success(let review) = result else {
            XCTFail("Malformed review should normalize to needs_input")
            return
        }
        XCTAssertEqual(review["decision"] as? String, "needs_input")
        XCTAssertEqual(review["confidence"] as? String, "low")
        XCTAssertNotNil(review["evidenceFactIds"] as? [Any])
        XCTAssertNotNil(review["blockingFactIds"] as? [Any])
        XCTAssertNotNil(review["missingFactIds"] as? [Any])
    }
}

private func runtimeConfig(
    provider: String,
    apiFormat: String,
    model: String,
    baseUrl: String? = nil
) -> AgenticAgentRuntimeConfig {
    AgenticAgentRuntimeConfig(
        provider: provider,
        apiFormat: apiFormat,
        model: model,
        baseUrl: baseUrl,
        apiKey: "sk-test",
        walletAddress: nil
    )
}

private final class NoopAgentProvider: AgenticAgentProvider {
    func execute(request: AgenticAgentRequest, completion: @escaping (Result<[String: Any], AgenticAgentError>) -> Void) {
        completion(.success([:]))
    }
}
