import XCTest
@testable import SolanaAgentWalletAdapterIosCapacitorBridge

final class SecretRedactorTests: XCTestCase {
    func testFixtureCases() throws {
        let cases = try XCTUnwrap(FixtureLoader.loadJson("secret-redactor-cases") as? [[String: Any]])
        for c in cases {
            let name = (c["name"] as? String) ?? "?"
            let input = c["input"] as! String
            let expected = c["expected"] as! String
            let actual = AgenticSecretRedactor.redact(input)
            XCTAssertEqual(actual, expected, "redactor case '\(name)' mismatch")
        }
    }

    func testCustomSecretWipe() {
        let s = AgenticSecretRedactor.redact("the token is mySecret123 and api_key=xxxxxxxxxxxxxxxx", secret: "mySecret123")
        XCTAssertTrue(s.contains("[redacted]"))
        XCTAssertFalse(s.contains("mySecret123"))
    }
}
