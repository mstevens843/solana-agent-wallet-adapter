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
