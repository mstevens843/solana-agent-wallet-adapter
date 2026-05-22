// Loads cross-platform JSON fixtures from the test bundle.
// Fixtures live in packages/shared-test-fixtures and are mirrored into
// Tests/Fixtures by scripts/sync-fixtures.mjs.
import Foundation
import XCTest

enum FixtureLoader {
    static func load(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
                    ?? Bundle.module.url(forResource: name, withExtension: "json") else {
            XCTFail("Fixture not found: \(name).json — did you run scripts/sync-fixtures.mjs?", file: file, line: line)
            throw NSError(domain: "FixtureLoader", code: 1)
        }
        return try Data(contentsOf: url)
    }

    static func loadJson(_ name: String) throws -> Any {
        let data = try load(name)
        return try JSONSerialization.jsonObject(with: data, options: [])
    }
}
