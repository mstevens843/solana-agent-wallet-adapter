import XCTest

func setupSnapshot(_ app: XCUIApplication) {
    app.launchEnvironment["FASTLANE_SNAPSHOT"] = "1"
}

func snapshot(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIApplication().screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    XCTContext.runActivity(named: "Snapshot: \(name)") { activity in
        activity.add(attachment)
    }
}
