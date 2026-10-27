import XCTest
@testable import OxasLibrary

@MainActor final class BackgroundCompletionTests: XCTestCase {
    func testOperatingSystemCompletionWaitsForDurabilityBarrier() async {
        let identifier = UUID().uuidString
        var durable = false, completed = false
        BackgroundEvents.completions[identifier] = {
            XCTAssertTrue(durable, "iOS must not suspend before the completed path is saved")
            completed = true
        }
        await BackgroundEvents.finish(identifier, persist: {
            XCTAssertFalse(completed)
            await Task.yield()
            XCTAssertFalse(completed)
            durable = true
        }, onError: { _ in XCTFail("Unexpected persistence error") })
        XCTAssertTrue(completed)
        XCTAssertNil(BackgroundEvents.completions[identifier])
    }
    func testPersistenceFailureIsSurfacedBeforeReleasingTheSystemHandler() async {
        let identifier = UUID().uuidString
        var reported = false, completed = false
        BackgroundEvents.completions[identifier] = { XCTAssertTrue(reported); completed = true }
        await BackgroundEvents.finish(identifier, persist: {
            throw CocoaError(.fileWriteOutOfSpace)
        }, onError: { _ in reported = true })
        XCTAssertTrue(completed)
        XCTAssertNil(BackgroundEvents.completions[identifier])
    }
}
