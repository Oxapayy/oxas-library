import XCTest
@testable import OxasLibrary

final class CloudPayloadTests: XCTestCase {
    func testAccountSourcePayloadPreservesWireFormat() throws {
        let data = Data(#"{"value":"fixture-encoded-source","format":"account-v2"}"#.utf8)
        let payload = try JSONDecoder().decode(CloudPayload.self, from: data)
        XCTAssertEqual(payload.format, "account-v2")
        let copy = try JSONDecoder().decode(CloudPayload.self, from: JSONEncoder().encode(payload))
        XCTAssertEqual(copy.format, payload.format)
        XCTAssertEqual(copy.value, payload.value)
    }

    func testLegacyPayloadKeepsMissingFormatForMigration() throws {
        let legacy = try JSONDecoder().decode(CloudPayload.self, from: Data(#"{"value":"fixture-legacy"}"#.utf8))
        XCTAssertEqual(legacy.value, "fixture-legacy")
        XCTAssertNil(legacy.format)
        let tombstone = try JSONDecoder().decode(CloudPayload.self, from: Data("{}".utf8))
        XCTAssertEqual(tombstone.value, "")
        XCTAssertNil(tombstone.format)
    }
}
