import XCTest

final class AgenticScreenshots: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCaptureDemo() throws {
        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchArguments.append("--agentic-screenshot-mode")
        app.launch()

        let webView = app.webViews.firstMatch
        let loaded = webView.waitForExistence(timeout: 30)
            || app.staticTexts.firstMatch.waitForExistence(timeout: 10)
            || app.buttons.firstMatch.waitForExistence(timeout: 10)
        XCTAssertTrue(loaded, "Agentic demo UI did not become visible for screenshots.")

        snapshot("01-demo")
    }
}
