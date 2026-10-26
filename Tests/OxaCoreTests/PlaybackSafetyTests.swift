import XCTest
@testable import OxaCore

final class PlaybackSafetyTests: XCTestCase {
    private func fixture() throws { guard ProcessInfo.processInfo.environment["OXA_PROVIDER_FIXTURES"] == "1" else { throw XCTSkip("Enable provider fixtures") } }
    private func client(assisted: Bool = true) -> WebsiteLibrary {
        let source = MediaSource(name: "Local fixture", kind: .website, host: "127.0.0.1", allowHTTP: true, allowProviderFetch: assisted)
        return WebsiteLibrary(source: source, endpoint: URL(string: "http://127.0.0.1:8789/website")!)
    }
    func testCreditsPromptUsesMarkersAndBoundedFallback() {
        XCTAssertFalse(PlaybackPolicy.nextEpisodePrompt(at: 100, duration: 2400, creditsStart: nil))
        XCTAssertTrue(PlaybackPolicy.nextEpisodePrompt(at: 2370, duration: 2400, creditsStart: nil))
        XCTAssertFalse(PlaybackPolicy.nextEpisodePrompt(at: 2300, duration: 2400, creditsStart: nil))
        XCTAssertTrue(PlaybackPolicy.nextEpisodePrompt(at: 2200, duration: 2400, creditsStart: 2200))
        XCTAssertFalse(PlaybackPolicy.nextEpisodePrompt(at: .infinity, duration: 2400, creditsStart: nil))
        XCTAssertFalse(PlaybackPolicy.nextEpisodePrompt(at: 20, duration: .nan, creditsStart: nil))
    }
    func testHTTPStreamConsentDoesNotAllowHTTPLoginEndpoints() throws {
        var source = MediaSource(name: "Fixture", kind: .website, host: "example.org")
        XCTAssertThrowsError(try URLPolicy.validateStream("http://example.org/live.m3u8", source: source))
        source.allowInsecureStreams = true
        XCTAssertEqual(try URLPolicy.validateStream("http://example.org/live.m3u8", source: source).scheme, "http")
        XCTAssertThrowsError(try URLPolicy.validate("http://example.org/login", allowHTTP: source.allowHTTP))
        XCTAssertThrowsError(try URLPolicy.validateStream("http://user:secret@example.org/live", source: source))
    }

    func testUnsafeDurationsAndPublicAddressRanges() {
        for value in [Double.infinity, Double.nan, 1e30, -1e30, -1] { XCTAssertEqual(value.boundedDuration, 0); XCTAssertEqual(value.clock, "0:00") }
        XCTAssertEqual(3601.0.clock, "1:00:01")
        for address in ["127.0.0.1","10.1.2.3","169.254.169.254","100.64.1.1","192.168.1.1","198.18.0.1","224.0.0.1","::1","fc00::1","fe80::1","::ffff:127.0.0.1","2001:db8::1"] { XCTAssertFalse(NetworkPolicy.isPublicAddress(address), address) }
        for address in ["8.8.8.8","1.1.1.1","2606:4700:4700::1111"] { XCTAssertTrue(NetworkPolicy.isPublicAddress(address), address) }
    }
    func testPublicPolicyRejectsLocalBeforeFetching() async throws {
        for raw in ["http://127.0.0.1/a","https://localhost/a","https://192.168.1.1/a"] {
            do { try await NetworkPolicy.validate(URL(string: raw)!, allowHTTP: true, publicOnly: true); XCTFail(raw) } catch { XCTAssertTrue(error is OxaError) }
        }
    }
    func testSourceSelectionKeepsServerLanguageAndQuality() async throws {
        try fixture(); let library = client(); let result = try await library.catalog(); let connection = try XCTUnwrap(result.websiteConnection)
        let item = try XCTUnwrap(result.media.first { $0.kind == .movie })
        let (_, choices) = try await library.sources(item, connection: connection)
        XCTAssertEqual(choices.first { $0.name == "Assisted server" }?.languages, ["de"])
        XCTAssertEqual(choices.first { $0.name == "Assisted server" }?.quality, "720p")
        XCTAssertTrue(choices.contains { $0.kind == "website" })
    }
    func testClientFetchCompletesWithoutAppCredentials() async throws {
        try fixture(); let library = client(); let catalog = try await library.catalog(); let connection = try XCTUnwrap(catalog.websiteConnection)
        let item = try XCTUnwrap(catalog.media.first { $0.kind == .movie })
        let (detailed, choices) = try await library.sources(item, connection: connection)
        let choice = try XCTUnwrap(choices.first { $0.name == "Assisted server" })
        let prepared = try await library.playable(detailed, connection: connection, selected: choice)
        XCTAssertEqual(prepared.stream?.path, "/test-stream.mp4"); XCTAssertEqual(prepared.streamFormat, "mp4")
        XCTAssertNil(prepared.playbackHeaders?["Authorization"])
    }
    func testAssistedRequestsNeedConsentAndHaveStepLimit() async throws {
        try fixture(); let library = client(assisted: false); let catalog = try await library.catalog(); let connection = try XCTUnwrap(catalog.websiteConnection)
        let item = try XCTUnwrap(catalog.media.first { $0.kind == .movie })
        let (detailed, choices) = try await library.sources(item, connection: connection)
        let choice = try XCTUnwrap(choices.first { $0.name == "Assisted server" })
        do { _ = try await library.playable(detailed, connection: connection, selected: choice); XCTFail() } catch { XCTAssertTrue(error.localizedDescription.contains("Enable")) }
        var loop = choice; loop.url = URL(string: "http://127.0.0.1:8789/website/watch/loop")!
        do { _ = try await client().playable(detailed, connection: connection, selected: loop); XCTFail() } catch { XCTAssertTrue(error.localizedDescription.contains("limit")) }
    }
    func testHTMLCandidateNeverBecomesPlayerURL() async throws {
        try fixture(); let library = client(); let result = try await library.catalog(); let connection = try XCTUnwrap(result.websiteConnection)
        let item = try XCTUnwrap(result.media.first { $0.kind == .movie }); let (detailed, choices) = try await library.sources(item, connection: connection)
        let choice = try XCTUnwrap(choices.first { $0.name == "HTML page" })
        do { _ = try await library.playable(detailed, connection: connection, selected: choice); XCTFail() } catch { XCTAssertTrue(error.localizedDescription.contains("web page")) }
    }
    func testActualAndDeclaredResponseBytesAreBounded() async throws {
        try fixture()
        for path in ["oversized-declared", "oversized-stream"] {
            do { _ = try await BoundedHTTP.fetch(URLRequest(url: URL(string: "http://127.0.0.1:8789/\(path)")!), limit: 1024, allowHTTP: true); XCTFail() } catch { XCTAssertTrue(error.localizedDescription.contains("size limit"), "\(path): \(error)") }
        }
    }
}
