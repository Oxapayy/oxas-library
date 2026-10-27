import XCTest

/// This fixture is fully local and uses preview storage. Run on a disposable
/// simulator: no provider traffic, account session or user library is needed.
final class PerformanceUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testLargeLibraryMenusRemainResponsiveWhileDownloadProgressChanges() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-large-library"]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["media-card-film-0"].waitForExistence(timeout: 15))
        var timings: [String: Double] = [:]

        // 20,500 titles and 20,000 guide entries are loaded, while a transfer
        // publishes four updates per second. These gestures must stay usable.
        let scrollStart = ProcessInfo.processInfo.systemUptime
        app.swipeUp(); app.swipeDown()
        timings["library-scroll"] = ProcessInfo.processInfo.systemUptime - scrollStart
        XCTAssertLessThan(timings["library-scroll"]!, 10)

        open("Search", in: app, marker: app.searchFields.firstMatch, timings: &timings)
        let searchStart = ProcessInfo.processInfo.systemUptime
        let search = app.searchFields.firstMatch
        search.tap(); search.typeText("Fixture Series 42")
        let series = app.buttons["search-result-series-42"]
        XCTAssertTrue(series.waitForExistence(timeout: 6))
        timings["series-search"] = ProcessInfo.processInfo.systemUptime - searchStart
        XCTAssertLessThan(timings["series-search"]!, 10)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "search-result-episode-")).count, 0)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "search-result-")).count, 1)

        let detailsStart = ProcessInfo.processInfo.systemUptime
        series.tap()
        XCTAssertTrue(app.staticTexts["Episode 1"].firstMatch.waitForExistence(timeout: 6))
        timings["series-details-100-episodes"] = ProcessInfo.processInfo.systemUptime - detailsStart
        XCTAssertLessThan(timings["series-details-100-episodes"]!, 8)
        app.swipeUp(); app.swipeDown()
        let back = app.navigationBars.buttons["Search"]
        if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }

        open("IPTV", in: app, marker: app.buttons["play-channel-channel-0"], timings: &timings)
        app.buttons["Program Guide"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Fixture Channel 0"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Program 1"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        let channelSearch = app.searchFields.firstMatch
        channelSearch.tap(); channelSearch.typeText("Fixture Channel 399")
        XCTAssertTrue(app.buttons["play-channel-channel-399"].waitForExistence(timeout: 6))
        if app.keyboards.buttons["Search"].exists { app.keyboards.buttons["Search"].tap() }
        else if app.buttons["Cancel"].firstMatch.exists { app.buttons["Cancel"].firstMatch.tap() }

        let progress = app.staticTexts["download-progress-performance-film-0"]
        open("Downloads", in: app, marker: progress, timings: &timings)
        let initialProgress = progress.label
        let updates = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in progress.exists && progress.label != initialProgress }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [updates], timeout: 3), .completed, "The stress transfer must actually keep updating during this test")

        open("Settings", in: app, marker: app.navigationBars["Settings"], timings: &timings)
        open("Library", in: app, marker: app.buttons["media-card-film-0"], timings: &timings)
        open("Search", in: app, marker: app.buttons["search-result-series-42"], timings: &timings)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        open("Downloads", in: app, marker: progress, timings: &timings)
        XCTAssertNotEqual(progress.label, initialProgress)

        let json = try JSONSerialization.data(withJSONObject: timings, options: [.prettyPrinted, .sortedKeys])
        let measurements = XCTAttachment(data: json, uniformTypeIdentifier: "public.json")
        measurements.name = "Large library interaction timings in seconds"; measurements.lifetime = .keepAlways; add(measurements)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Live download progress after large library navigation"; screenshot.lifetime = .keepAlways; add(screenshot)
    }

    private func open(_ title: String, in app: XCUIApplication, marker: XCUIElement, timings: inout [String: Double]) {
        let start = ProcessInfo.processInfo.systemUptime
        app.tabBars.buttons[title].tap()
        XCTAssertTrue(marker.waitForExistence(timeout: 5), "\(title) did not become usable")
        let elapsed = ProcessInfo.processInfo.systemUptime - start
        timings["tab-\(title)-\(timings.count)"] = elapsed
        // Includes XCTest animation/idling overhead; this is a hang regression
        // boundary, not a claim about measured frame rate on a physical iPhone.
        XCTAssertLessThan(elapsed, 8, "\(title) menu was blocked")
    }
}
