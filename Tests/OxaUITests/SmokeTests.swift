import XCTest
final class SmokeTests: XCTestCase {
    override func setUp() { continueAfterFailure = false; XCUIDevice.shared.orientation = .portrait }
    override func tearDown() { XCUIDevice.shared.orientation = .portrait; super.tearDown() }
    func testFirstRunAndInvalidSource() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-test-reset"]; app.launch()
        XCTAssertTrue(app.buttons["Add Your First Source"].waitForExistence(timeout: 10))
        let first = XCTAttachment(screenshot: app.screenshot()); first.name = "First launch"; first.lifetime = .keepAlways; add(first)
        app.buttons["Add Your First Source"].tap()
        let field = app.textFields["source-url"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("not-a-url")
        app.swipeUp()
        app.buttons["connect-source"].tap()
        XCTAssertTrue(app.staticTexts["source-error"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["source-error"].label.contains("valid HTTP"))
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Source validation"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["Cancel"].tap()
        app.tabBars.buttons["IPTV"].tap()
        XCTAssertTrue(app.staticTexts["Your live TV, together"].waitForExistence(timeout: 5))
        let tv = XCTAttachment(screenshot: app.screenshot()); tv.name = "IPTV empty state"; tv.lifetime = .keepAlways; add(tv)
        app.tabBars.buttons["Downloads"].tap()
        XCTAssertTrue(app.staticTexts["Take your library with you"].waitForExistence(timeout: 5))
    }
    func testPreviewLibrary() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-test-reset", "--preview-library"]; app.launch()
        XCTAssertTrue(app.staticTexts["Continue Watching"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Preview library · illustrative titles"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Preview Library"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.swipeUp()
        let collection = XCTAttachment(screenshot: app.screenshot()); collection.name = "Preview Collection"; collection.lifetime = .keepAlways; add(collection)
        app.tabBars.buttons["Settings"].tap()
        let settings = XCTAttachment(screenshot: app.screenshot()); settings.name = "Settings"; settings.lifetime = .keepAlways; add(settings)
    }
    func testLocalVideoDownloadAndPersistentResume() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-test-reset"]; app.launch()
        app.buttons["Add Your First Source"].tap()
        app.buttons["source-kind"].tap()
        app.buttons["Video URL"].tap()
        let field = app.textFields["source-url"]
        field.tap(); field.typeText("http://127.0.0.1:8787/test-video.mp4")
        app.buttons["Done"].tap()
        let toggle = app.switches["source-http"]
        if !toggle.isHittable { app.swipeUp() }
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertEqual(toggle.value as? String, "1")
        app.buttons["connect-source"].tap()
        XCTAssertTrue(app.buttons["media-card-direct"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.alerts.firstMatch.exists)
        app.buttons["media-card-direct"].tap()
        app.buttons["Download"].tap()
        app.tabBars.buttons["Downloads"].tap()
        XCTAssertTrue(app.buttons["Play Offline"].waitForExistence(timeout: 30))
        app.buttons["Play Offline"].tap()
        XCTAssertTrue(app.buttons["Forward 10 seconds"].waitForExistence(timeout: 10))
        app.buttons["Forward 10 seconds"].tap()
        app.buttons["Close player"].tap()
        app.tabBars.buttons["Library"].tap()
        if app.navigationBars.buttons["Back"].exists { app.navigationBars.buttons["Back"].tap() }
        XCTAssertTrue(app.staticTexts["Continue Watching"].waitForExistence(timeout: 5))
        app.terminate(); app.launchArguments = []; app.launch()
        if app.buttons["welcome-guest"].waitForExistence(timeout: 3) { app.buttons["welcome-guest"].tap() }
        XCTAssertTrue(app.staticTexts["Continue Watching"].waitForExistence(timeout: 10))
        app.tabBars.buttons["Downloads"].tap()
        XCTAssertTrue(app.buttons["Play Offline"].waitForExistence(timeout: 5))
        app.buttons["Delete download of test-video"].tap()
        app.buttons["Delete Download"].tap()
        XCTAssertTrue(app.staticTexts["Take your library with you"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Library"].tap()
        if app.navigationBars.buttons["Back"].exists { app.navigationBars.buttons["Back"].tap() }
        XCTAssertTrue(app.staticTexts["Continue Watching"].waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Persistent resume after deleting download"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    func testWebsiteLibraryImportsFilmsSeriesEpisodesAndTV() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-test-reset"]; app.launch()
        app.buttons["Add Your First Source"].tap()
        let field = app.textFields["source-url"]
        field.tap(); field.typeText("http://127.0.0.1:8789/website")
        app.buttons["Done"].tap()
        let toggle = app.switches["source-http"]
        if !toggle.isHittable { app.swipeUp() }
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        app.buttons["connect-source"].tap()
        XCTAssertTrue(app.buttons["media-card-fixture-metadata:video:movie-1"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["media-card-fixture-metadata:series:show-1"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Imported Website Library"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["media-card-fixture-metadata:series:show-1"].tap()
        XCTAssertTrue(app.staticTexts["First Episode"].waitForExistence(timeout: 10))
        app.tabBars.buttons["IPTV"].tap()
        XCTAssertTrue(app.buttons["play-channel-fixture-live:live:tv-1"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Search"].tap()
        let search = app.searchFields.firstMatch
        search.tap(); search.typeText("Remote")
        XCTAssertTrue(app.buttons["search-result-fixture-metadata:video:search-only"].waitForExistence(timeout: 10))
    }
    private func connectWebsite(_ app: XCUIApplication) {
        app.buttons["Add Your First Source"].tap()
        let field = app.textFields["source-url"]; field.tap(); field.typeText("http://127.0.0.1:8789/website")
        app.buttons["Done"].tap()
        let toggle = app.switches["source-http"]
        if !toggle.isHittable { app.swipeUp() }
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        app.buttons["connect-source"].tap()
        XCTAssertTrue(app.buttons["media-card-fixture-metadata:video:movie-1"].waitForExistence(timeout: 15))
    }
    func testWebsiteServerSelectionClientFetchAndNativePlayback() {
        let app = XCUIApplication(); app.launchEnvironment["OXA_PROVIDER_FIXTURES"] = "1"; app.launchArguments = ["--ui-test-reset"]; app.launch()
        connectWebsite(app)
        app.buttons["media-card-fixture-metadata:video:movie-1"].tap()
        app.buttons["Play"].tap()
        let html = app.buttons["play-source-HTML page"]
        XCTAssertTrue(html.waitForExistence(timeout: 10)); html.tap()
        XCTAssertTrue(app.staticTexts["This server returned a web page instead of a playable video. Choose another server."].waitForExistence(timeout: 8))
        let toggle = app.switches["Provider-assisted requests"]
        if !toggle.isHittable { app.swipeUp() }
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        let assisted = app.buttons["play-source-Assisted server"]
        if !assisted.isHittable { app.swipeDown() }
        let sources = XCTAttachment(screenshot: app.screenshot()); sources.name = "Server selection"; sources.lifetime = .keepAlways; add(sources)
        assisted.tap()
        XCTAssertTrue(app.buttons["Change source"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["playback-caption"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["playback-caption"].label.trimmingCharacters(in: .whitespacesAndNewlines), "Fixture caption")
        XCTAssertFalse(app.buttons["Retry"].exists)
        let playing = XCTAttachment(screenshot: app.screenshot()); playing.name = "Resolved native playback"; playing.lifetime = .keepAlways; add(playing)
        app.buttons["Change source"].tap()
        XCTAssertTrue(app.buttons["play-source-Playable candidate"].waitForExistence(timeout: 8))
        app.buttons["play-source-Playable candidate"].tap()
        XCTAssertTrue(app.buttons["Change source"].waitForExistence(timeout: 10))
        app.buttons["Close player"].tap()
    }
    func testOptionalEmailAccountAndPendingSetup() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-test-reset"]; app.launch()
        app.tabBars.buttons["Settings"].tap()
        app.buttons["account-settings"].tap()
        XCTAssertTrue(app.textFields["account-email"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Continue with Apple"].exists)
        XCTAssertFalse(app.buttons["Continue with Google"].exists)
        XCTAssertTrue(app.buttons["Continue Without Account"].exists)
        let screen = XCTAttachment(screenshot: app.screenshot()); screen.name = "Optional email account"; screen.lifetime = .keepAlways; add(screen)
        app.buttons["Continue Without Account"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    func testLandscapeFillNextEpisodeAndCountdown() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-test-reset", "--ui-test-episode-player"]; app.launch()
        XCTAssertTrue(app.buttons["Fill screen"].waitForExistence(timeout: 15))
        XCUIDevice.shared.orientation = .landscapeLeft
        app.buttons["Fill screen"].tap()
        XCTAssertTrue(app.buttons["Fit video"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Retry"].exists)
        let close = app.buttons["Close player"].frame, next = app.buttons["next-episode"].frame
        XCTAssertGreaterThan(next.minX, close.maxX + 300, "Landscape controls must span the viewport")
        app.buttons["Forward 10 seconds"].tap(); app.buttons["Forward 10 seconds"].tap()
        XCTAssertTrue(app.staticTexts["next-countdown"].waitForExistence(timeout: 8))
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "Landscape player and countdown"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["Cancel"].tap()
        app.buttons["next-episode"].tap()
        XCTAssertTrue(app.staticTexts["S1 · E2 · Second Episode"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["Retry"].exists)
        app.buttons["Close player"].tap(); XCUIDevice.shared.orientation = .portrait
    }
    func testSourceRemoveIsIndependentFromRefreshAndEdit() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-test-reset"]; app.launch()
        connectWebsite(app)
        app.tabBars.buttons["Settings"].tap()
        app.buttons["Remove"].tap()
        XCTAssertTrue(app.buttons["Remove Source"].waitForExistence(timeout: 5))
        app.buttons["Remove Source"].tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Remove"])
        wait(for: [gone], timeout: 5)
    }

    func testWelcomeAndWebsiteDownload() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-test-reset", "--ui-test-account-welcome"]; app.launch()
        XCTAssertTrue(app.buttons["welcome-guest"].waitForExistence(timeout: 10))
        let welcome = XCTAttachment(screenshot: app.screenshot()); welcome.name = "Optional startup account"; welcome.lifetime = .keepAlways; add(welcome)
        app.buttons["welcome-guest"].tap()
        connectWebsite(app)
        app.buttons["media-card-fixture-metadata:video:movie-1"].tap()
        app.buttons["Download"].tap()
        XCTAssertTrue(app.buttons["play-source-Playable candidate"].waitForExistence(timeout: 10))
        app.buttons["play-source-Playable candidate"].tap()
        app.tabBars.buttons["Downloads"].tap()
        XCTAssertTrue(app.buttons["Play Offline"].waitForExistence(timeout: 30))
        let offline = XCTAttachment(screenshot: app.screenshot()); offline.name = "Ready offline download"; offline.lifetime = .keepAlways; add(offline)
        app.buttons["Play Offline"].tap()
        XCTAssertTrue(app.buttons["Fill screen"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Retry"].exists)
        app.buttons["Close player"].tap()
    }

}
