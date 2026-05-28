import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class ProviderHttpTests: XCTestCase {
    func testMapsHttpStatusToSharedProviderCodes() {
        XCTAssertNil(AgenticProviderHttp.mapHttpStatusToErrorCode(200))
        XCTAssertEqual(AgenticProviderHttp.mapHttpStatusToErrorCode(401), AgenticProviderErrorCodes.auth)
        XCTAssertEqual(AgenticProviderHttp.mapHttpStatusToErrorCode(403), AgenticProviderErrorCodes.auth)
        XCTAssertEqual(AgenticProviderHttp.mapHttpStatusToErrorCode(429), AgenticProviderErrorCodes.rateLimited)
        XCTAssertEqual(AgenticProviderHttp.mapHttpStatusToErrorCode(504), AgenticProviderErrorCodes.timeout)
        XCTAssertEqual(AgenticProviderHttp.mapHttpStatusToErrorCode(500), AgenticProviderErrorCodes.upstream)
        XCTAssertEqual(AgenticProviderHttp.mapHttpStatusToErrorCode(422), AgenticProviderErrorCodes.invalidResponse)
    }

    func testNormalizesOpenAICompatibleBaseUrls() {
        XCTAssertEqual(AgenticProviderHttp.normalizeBaseUrl(nil, apiFormat: "openai-compatible"), "https://api.openai.com/v1")
        XCTAssertEqual(AgenticProviderHttp.normalizeBaseUrl("https://api.openai.com", apiFormat: "openai-compatible"), "https://api.openai.com/v1")
        XCTAssertEqual(AgenticProviderHttp.normalizeBaseUrl("https://api.openai.com/v1", apiFormat: "openai-compatible"), "https://api.openai.com/v1")
        XCTAssertEqual(AgenticProviderHttp.normalizeBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai", apiFormat: "openai-compatible"), "https://generativelanguage.googleapis.com/v1beta/openai")
    }

    func testNormalizesAnthropicBaseUrls() {
        XCTAssertEqual(AgenticProviderHttp.normalizeBaseUrl(nil, apiFormat: "anthropic"), "https://api.anthropic.com/v1")
        XCTAssertEqual(AgenticProviderHttp.normalizeBaseUrl("https://api.anthropic.com", apiFormat: "anthropic"), "https://api.anthropic.com/v1")
        XCTAssertEqual(AgenticProviderHttp.normalizeBaseUrl("https://api.anthropic.com/v1", apiFormat: "anthropic"), "https://api.anthropic.com/v1")
    }

    func testNormalizesGeminiNativeBaseUrls() {
        XCTAssertEqual(AgenticProviderHttp.normalizeNativeBaseUrl(nil), "https://generativelanguage.googleapis.com/v1beta")
        XCTAssertEqual(AgenticProviderHttp.normalizeNativeBaseUrl("https://generativelanguage.googleapis.com"), "https://generativelanguage.googleapis.com/v1beta")
        XCTAssertEqual(AgenticProviderHttp.normalizeNativeBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai"), "https://generativelanguage.googleapis.com/v1beta")
        XCTAssertEqual(AgenticProviderHttp.normalizeNativeBaseUrl("https://generativelanguage.googleapis.com/v1beta"), "https://generativelanguage.googleapis.com/v1beta")
    }

    func testModelTokenAndReasoningParity() {
        XCTAssertEqual(AgenticProviderHttp.tokenLimitKey("gpt-5"), "max_completion_tokens")
        XCTAssertEqual(AgenticProviderHttp.tokenLimitKey("openai/gpt-5-mini"), "max_completion_tokens")
        XCTAssertEqual(AgenticProviderHttp.tokenLimitKey("o3-mini"), "max_completion_tokens")
        XCTAssertEqual(AgenticProviderHttp.tokenLimitKey("claude-3-5-sonnet"), "max_tokens")
        XCTAssertTrue(AgenticProviderHttp.isReasoningModel("gpt-5"))
        XCTAssertFalse(AgenticProviderHttp.isReasoningModel("gpt-4o"))
    }

    func testRejectsUnsafeApiKeyHeaderCharacters() {
        XCTAssertNoThrow(try AgenticProviderHttp.assertApiKeyHeaderSafe("sk-live_123.ABC"))
        XCTAssertThrowsError(try AgenticProviderHttp.assertApiKeyHeaderSafe("sk-live 123")) { error in
            XCTAssertEqual((error as? AgenticAgentError)?.code, AgenticProviderErrorCodes.invalidConfig)
        }
        XCTAssertThrowsError(try AgenticProviderHttp.assertApiKeyHeaderSafe("sk-live\n123")) { error in
            XCTAssertEqual((error as? AgenticAgentError)?.code, AgenticProviderErrorCodes.invalidConfig)
        }
        XCTAssertThrowsError(try AgenticProviderHttp.assertApiKeyHeaderSafe("sk-\u{00a0}key")) { error in
            XCTAssertEqual((error as? AgenticAgentError)?.code, AgenticProviderErrorCodes.invalidConfig)
        }
    }

    func testComposesProviderErrorMessages() {
        let message = AgenticProviderHttp.composeErrorMessage(
            status: 401,
            body: #"{"error":{"message":"Invalid key"}}"#
        )
        XCTAssertTrue(message.hasPrefix("Invalid key."))
        XCTAssertTrue(message.contains("Re-enter the API key"))

        let generic = AgenticProviderHttp.composeErrorMessage(status: 503, body: "")
        XCTAssertTrue(generic.hasPrefix("AI provider returned HTTP 503."))
        XCTAssertTrue(generic.contains("temporarily unavailable"))
    }
}
