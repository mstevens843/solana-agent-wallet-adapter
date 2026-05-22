// Pin Swift system-prompt strings to the Android source of truth. Drift on
// either platform breaks this test and surfaces immediately in CI.
import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class DeviceAgentSystemPromptsTests: XCTestCase {
    func testPlanPromptByteIdentical() throws {
        let fixture = try fixture()
        XCTAssertEqual(AgenticDeviceAgentSystemPrompts.plan, fixture.plan, "PLAN prompt diverged from Android source")
    }

    func testReviewPromptByteIdentical() throws {
        let fixture = try fixture()
        XCTAssertEqual(AgenticDeviceAgentSystemPrompts.review, fixture.review, "REVIEW prompt diverged from Android source")
    }

    func testAskPromptByteIdentical() throws {
        let fixture = try fixture()
        XCTAssertEqual(AgenticDeviceAgentSystemPrompts.ask, fixture.ask, "ASK prompt diverged from Android source")
    }

    private struct Prompts: Codable {
        let plan: String
        let review: String
        let ask: String
    }

    private func fixture() throws -> Prompts {
        let data = try FixtureLoader.load("system-prompts")
        return try JSONDecoder().decode(Prompts.self, from: data)
    }
}
