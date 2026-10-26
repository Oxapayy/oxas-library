import XCTest
@testable import OxaCore

final class ProviderTests: XCTestCase {
    private func api(_ kind: SourceKind, path: String) -> MediaAPI {
        let source = MediaSource(name: "Fixture", kind: kind, host: "127.0.0.1", allowHTTP: true)
        return MediaAPI(source: source, credentials: Credentials(endpoint: "http://127.0.0.1:8789/\(path)", username: "fixture", password: "fixture-password", token: "fixture-token", userID: "user-1"))
    }
    private func requireFixtures() throws {
        guard ProcessInfo.processInfo.environment["OXA_PROVIDER_FIXTURES"] == "1" else { throw XCTSkip("Start scripts/api-fixture-server.py and set OXA_PROVIDER_FIXTURES=1 to run provider contract tests.") }
    }
    func testJellyfinAuthenticationPaginationAndPlayback() async throws {
        try requireFixtures()
        var client = api(.jellyfin, path: "jellyfin")
        let auth = try await client.authenticate()
        XCTAssertEqual(auth.token, "fixture-token"); XCTAssertEqual(auth.userID, "user-1"); XCTAssertEqual(auth.password, "")
        client.credentials = auth
        let catalog = try await client.catalog()
        XCTAssertEqual(catalog.media.count, 2)
        XCTAssertEqual(catalog.media[0].title, "Fixture Movie"); XCTAssertEqual(catalog.media[0].duration, 24)
        XCTAssertEqual(catalog.media[1].seriesID, "series-1")
        let playback = try await client.playbackURL(catalog.media[0])
        XCTAssertEqual(playback.path, "/jellyfin/Videos/movie-1/stream.mp4")
        XCTAssertTrue(URLComponents(url: playback, resolvingAgainstBaseURL: true)!.queryItems!.contains { $0.name == "ApiKey" && $0.value == "fixture-token" })
    }
    func testEmbyAdapterUsesSameReadOnlyCatalogContract() async throws {
        try requireFixtures()
        let client = api(.emby, path: "emby")
        let catalog = try await client.catalog(); XCTAssertEqual(catalog.media.count, 2)
        let download = try await client.playbackURL(catalog.media[0], download: true)
        XCTAssertEqual(download.path, "/emby/Items/movie-1/Download")
    }
    func testPlexAllMediaKindsAndPartResolution() async throws {
        try requireFixtures()
        let client = api(.plex, path: "plex")
        let catalog = try await client.catalog()
        XCTAssertEqual(Set(catalog.media.map(\.kind)), Set([.movie, .series, .episode]))
        let stream = try await client.playbackURL(catalog.media[0])
        XCTAssertEqual(stream.path, "/plex/library/parts/file.mp4")
    }
    func testXtreamCatalogEpisodesAndGuide() async throws {
        try requireFixtures()
        let client = api(.xtream, path: "xtream")
        let catalog = try await client.catalog()
        XCTAssertEqual(catalog.media.count, 3); XCTAssertEqual(catalog.programs.count, 1)
        let series = try XCTUnwrap(catalog.media.first { $0.kind == .series })
        let episodes = try await client.episodes(series)
        XCTAssertEqual(episodes.count, 1); XCTAssertEqual(episodes[0].episode, 1); XCTAssertEqual(episodes[0].seriesID, "3")
        XCTAssertEqual(episodes[0].stream?.path, "/xtream/series/fixture/fixture-password/4.mp4")
    }
    func testM3UAndWebDAVCatalogs() async throws {
        try requireFixtures()
        let playlist = try await api(.m3u, path: "list.m3u").catalog()
        XCTAssertEqual(playlist.media.first?.title, "Fixture TV"); XCTAssertEqual(playlist.programs.first?.title, "Fixture Program")
        let dav = try await api(.webdav, path: "dav/").catalog()
        XCTAssertEqual(dav.media.count, 1); XCTAssertEqual(dav.media[0].title, "NAS Film")
    }
    func testRejectsCrossOriginRedirectAndBadAuth() async throws {
        try requireFixtures()
        let client = api(.direct, path: "redirect")
        do { _ = try await HTTPClient.shared.data(client.base, source: client.source, headers: ["Authorization":"Bearer fixture-token"]); XCTFail("Cross-origin redirects must be rejected") }
        catch { XCTAssertTrue(error.localizedDescription.contains("redirects")) }
        var bad = api(.jellyfin, path: "jellyfin"); bad.credentials.password = "wrong"
        do { _ = try await bad.authenticate(); XCTFail("Invalid login must fail") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Access denied")) }
    }
}
