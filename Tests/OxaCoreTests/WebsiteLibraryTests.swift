import XCTest
@testable import OxaCore

final class WebsiteLibraryTests: XCTestCase {
    private func api(_ path: String = "website", kind: SourceKind = .website) -> MediaAPI {
        let source = MediaSource(name: "Fixture website", kind: kind, host: "127.0.0.1", allowHTTP: true)
        return MediaAPI(source: source, credentials: Credentials(endpoint: "http://127.0.0.1:8789/\(path)"))
    }
    private func fixture() throws {
        guard ProcessInfo.processInfo.environment["OXA_PROVIDER_FIXTURES"] == "1" else { throw XCTSkip("Enable the local provider fixture server.") }
    }
    func testWebsiteRootImportsRealCatalogKindsNotOneFakeMovie() async throws {
        try fixture()
        let result = try await api(kind: .direct).catalog()
        XCTAssertNotNil(result.websiteConnection)
        XCTAssertEqual(Set(result.media.map(\.kind)), Set([.movie, .series, .channel]))
        XCTAssertEqual(result.media.count, 3)
        XCTAssertFalse(result.media.contains { $0.providerID == "direct" })
        XCTAssertEqual(result.programs.first?.title, "Fixture Show")
        let connection = try XCTUnwrap(result.websiteConnection)
        XCTAssertEqual(connection.addons.count, 3)
        XCTAssertFalse(connection.addons.contains { $0.baseURL.path.contains("disabled") })
    }
    func testCatalogPaginationAndRemoteSearch() async throws {
        try fixture()
        let client = api(); let result = try await client.catalog()
        let connection = try XCTUnwrap(result.websiteConnection)
        let library = WebsiteLibrary(source: client.source, endpoint: client.base)
        let page = try XCTUnwrap(result.websitePages.first { $0.catalog.type == "video" })
        XCTAssertEqual(page.cursor, "page-2")
        let second = try await library.loadPage(page, connection: connection)
        XCTAssertEqual(second.media.first?.title, "Second Library Film"); XCTAssertNil(second.page.cursor)
        let matches = try await library.search("Remote", connection: connection)
        XCTAssertTrue(matches.contains { $0.title == "Remote Only Film" })
    }
    func testSeriesSeasonsEpisodesKeepParentIdentity() async throws {
        try fixture()
        let api = api(); let result = try await api.catalog()
        let library = WebsiteLibrary(source: api.source, endpoint: api.base)
        let connection = try XCTUnwrap(result.websiteConnection)
        let series = try XCTUnwrap(result.media.first { $0.kind == .series })
        let details = try await library.details(series, connection: connection)
        XCTAssertEqual(details.media.websiteItem?.seasons.first?.number, 1)
        let episodes = try await library.season(details.media, number: 1, connection: connection)
        XCTAssertEqual(episodes.count, 1); XCTAssertEqual(episodes[0].kind, .episode)
        XCTAssertEqual(episodes[0].seriesID, series.providerID)
        XCTAssertEqual(episodes[0].websiteItem?.ids["tmdb"], "43:1:1")
    }
    func testProviderResolutionSkipsWebsiteLinksAndScopesHeaders() async throws {
        try fixture()
        var api = api(); let result = try await api.catalog()
        api = MediaAPI(source: MediaSource(id: api.source.id, name: "Fixture", kind: .website, host: "127.0.0.1", allowHTTP: true, websiteConnection: result.websiteConnection), credentials: api.credentials)
        let movie = try XCTUnwrap(result.media.first { $0.kind == .movie })
        let prepared = try await api.preparePlayback(movie, subtitleLanguage: "de")
        XCTAssertEqual(prepared.stream?.path, "/test-stream.mp4")
        XCTAssertEqual(prepared.streamFormat, "mp4")
        XCTAssertEqual(prepared.subtitleURL?.path, "/de.vtt")
        XCTAssertEqual(prepared.playbackHeaders?["Referer"], "http://127.0.0.1:8789")
        XCTAssertNil(prepared.playbackHeaders?["Authorization"])
        let playbackURL = try await api.playbackURL(prepared)
        XCTAssertEqual(playbackURL, prepared.stream)
    }
    func testPlainHTMLAddressIsRejectedNotInventedAsAFilm() async throws {
        try fixture()
        do { _ = try await api("invalid", kind: .direct).catalog(); XCTFail("HTML pages must not become movies") } catch { XCTAssertNotNil(error as? OxaError) }
        let video = try await api("extensionless-video", kind: .direct).catalog()
        XCTAssertEqual(video.media.count, 1); XCTAssertEqual(video.media.first?.providerID, "direct")
    }
    func testSourceCompatibilityAndResolverWildcards() throws {
        let id = UUID()
        let old = "{\"id\":\"\(id)\",\"name\":\"Old video\",\"kind\":\"Video URL\",\"host\":\"example.org\",\"allowHTTP\":false}"
        let source = try JSONDecoder().decode(MediaSource.self, from: Data(old.utf8))
        XCTAssertEqual(source.kind, .direct); XCTAssertNil(source.websiteConnection)
        XCTAssertTrue(WebsiteLibrary.matches("https://example.org/watch/123", pattern: "*//example.org/watch/*"))
        XCTAssertFalse(WebsiteLibrary.matches("https://example.org.attacker.test/watch/123", pattern: "*//example.org/watch/*"))
    }
    func testLiveHuhuCatalogMetadataOnly() async throws {
        guard ProcessInfo.processInfo.environment["OXA_LIVE_WEBSITE"] == "1" else { throw XCTSkip("Live provider verification is explicitly opt-in.") }
        let source = MediaSource(name: "User-specified website", kind: .website, host: "huhu.to")
        let api = MediaAPI(source: source, credentials: Credentials(endpoint: "https://huhu.to"))
        let result = try await api.catalog()
        XCTAssertNotNil(result.websiteConnection)
        XCTAssertTrue(result.media.contains { $0.kind == .movie && $0.poster != nil })
        XCTAssertTrue(result.media.contains { $0.kind == .series && $0.poster != nil })
        XCTAssertTrue(result.media.contains { $0.kind == .channel })
        XCTAssertFalse(result.media.contains { $0.providerID == "direct" })
        print("Live website catalog: \(result.media.filter { $0.kind == .movie }.count) films, \(result.media.filter { $0.kind == .series }.count) series, \(result.media.filter { $0.kind == .channel }.count) channels. No streams requested.")
    }
}
