import XCTest
@testable import OxaCore

final class CoreTests: XCTestCase {
    let sourceID = UUID(uuidString: "A5A5A5A5-1111-2222-3333-444444444444")!
    func testURLSecurityPolicy() throws {
        XCTAssertEqual(try URLPolicy.validate("https://media.example.org:8920/jellyfin", allowHTTP: false).path, "/jellyfin")
        XCTAssertThrowsError(try URLPolicy.validate("http://media.example.org", allowHTTP: true))
        XCTAssertThrowsError(try URLPolicy.validate("http://192.168.1.20:8096", allowHTTP: false))
        XCTAssertNoThrow(try URLPolicy.validate("http://192.168.1.20:8096", allowHTTP: true))
        XCTAssertNoThrow(try URLPolicy.validate("http://[fd12::1]:8096", allowHTTP: true))
        XCTAssertThrowsError(try URLPolicy.validate("https://user:password@example.org", allowHTTP: true))
        XCTAssertThrowsError(try URLPolicy.validate("file:///etc/passwd", allowHTTP: true))
        XCTAssertFalse(URLPolicy.isLocal("172.32.0.1"))
        XCTAssertFalse(URLPolicy.isLocal("192.168.1.20.attacker.example"))
        XCTAssertFalse(URLPolicy.sameOrigin(URL(string: "https://a.example")!, URL(string: "http://a.example")!))
        XCTAssertFalse(URLPolicy.sameOrigin(URL(string: "https://a.example:8443")!, URL(string: "https://a.example")!))
    }
    func testPlaylistIdentityAttributesAndRelativeURLs() throws {
        let text = """
        #EXTM3U x-tvg-url="guide.xml"
        #EXTINF:-1 tvg-id="news" tvg-logo="logo.png" group-title="News, local",Local News
        streams/news.m3u8
        #EXTINF:-1 tvg-id="arts" group-title="Culture",Arts Channel
        https://tv.example.org/arts.m3u8
        """
        let base = URL(string: "https://tv.example.org/catalog/list.m3u")!
        let items = try M3UParser.parse(text, sourceID: sourceID, baseURL: base)
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(try M3UParser.parse("\u{feff}" + text, sourceID: sourceID, baseURL: base).count, 2)
        XCTAssertEqual(items[0].title, "Local News")
        XCTAssertEqual(items[0].group, "News, local")
        XCTAssertEqual(items[0].stream?.absoluteString, "https://tv.example.org/catalog/streams/news.m3u8")
        XCTAssertEqual(M3UParser.guideURL(text, baseURL: base)?.absoluteString, "https://tv.example.org/catalog/guide.xml")
        let reordered = "#EXTM3U\n#EXTINF:-1 tvg-id=\"arts\",Arts Channel\nhttps://tv.example.org/arts.m3u8\n#EXTINF:-1 tvg-id=\"news\",Local News\nstreams/news.m3u8"
        let second = try M3UParser.parse(reordered, sourceID: sourceID, baseURL: base)
        XCTAssertEqual(items[0].id, second[1].id)
    }
    func testPlaylistRejectsVideoManifestAndInvalidData() {
        XCTAssertThrowsError(try M3UParser.parse("<html>login</html>", sourceID: sourceID, baseURL: URL(string: "https://example.org")!))
        XCTAssertThrowsError(try M3UParser.parse("#EXTM3U\n#EXT-X-TARGETDURATION:6\nclip.ts", sourceID: sourceID, baseURL: URL(string: "https://example.org")!))
        XCTAssertThrowsError(try M3UParser.parse("#EXTM3U\nfile:///etc/passwd", sourceID: sourceID, baseURL: URL(string: "https://example.org")!))
    }
    func testXMLTVTimezoneAndMalformedGuide() throws {
        let xml = """
        <tv><programme start="20261026200000 +0100" stop="20261026210000 +0100" channel="news"><title>Evening &amp; Night</title><desc>Today's report</desc></programme></tv>
        """
        let programs = try XMLTVParser(sourceID: sourceID).parse(Data(xml.utf8))
        XCTAssertEqual(programs.count, 1)
        XCTAssertEqual(programs[0].title, "Evening & Night")
        XCTAssertEqual(programs[0].start, XMLTVParser.date("20261026190000 +0000"))
        XCTAssertEqual(programs[0].end.timeIntervalSince(programs[0].start), 3600)
        XCTAssertThrowsError(try XMLTVParser(sourceID: sourceID).parse(Data("<broken>".utf8)))
    }
    func testDAVNamespaces() throws {
        let xml = "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/media/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/media/film.mp4</d:href><d:propstat><d:prop><d:displayname>My Film</d:displayname></d:prop></d:propstat></d:response></d:multistatus>"
        let entries = try DAVParser().parse(Data(xml.utf8))
        XCTAssertTrue(entries[0].directory); XCTAssertFalse(entries[1].directory); XCTAssertEqual(entries[1].name, "My Film")
    }
    func testLargeGuideMixedTimezonesAndParserReuse() throws {
        // A real guide has thousands of programmes and may mix explicit zones
        // with UTC. Reuse must replace the old guide rather than append to it.
        let rows = (0..<10_000).map { i in
            let start = i.isMultiple(of: 2) ? "20261026200000 +0100" : "20261026190000"
            return "<programme start=\"\(start)\" stop=\"20261026200000 +0000\" channel=\"channel-\(i)\"><title>Show \(i)</title></programme>"
        }.joined()
        let parser = XMLTVParser(sourceID: sourceID)
        let started = Date()
        let guide = try parser.parse(Data("<tv>\(rows)</tv>".utf8))
        print("XMLTV 10,000 programmes: \(Date().timeIntervalSince(started)) seconds")
        XCTAssertEqual(guide.count, 10_000)
        XCTAssertEqual(Set(guide.map(\.start)).count, 1)
        XCTAssertTrue(guide.allSatisfy { $0.end.timeIntervalSince($0.start) == 3600 })
        XCTAssertEqual(try parser.parse(Data("<tv/>".utf8)).count, 0)
    }
    func testLargePlaylistKeepsIdentityAndQuotedAttributes() throws {
        let header = "#EXTM3U x-tvg-url=\"guide.xml\"\n"
        let rows = (0..<10_000).map { "#EXTINF:-1 tvg-id=\"ch-\($0)\" group-title=\"News, local\",Channel \($0)\nstream/\($0).m3u8" }.joined(separator: "\n")
        let base = URL(string: "https://tv.example.org/list.m3u")!
        let started = Date()
        let channels = try M3UParser.parse(header + rows, sourceID: sourceID, baseURL: base)
        print("M3U 10,000 channels: \(Date().timeIntervalSince(started)) seconds")
        XCTAssertEqual(channels.count, 10_000)
        XCTAssertEqual(channels.last?.title, "Channel 9999")
        XCTAssertEqual(channels.last?.group, "News, local")
        XCTAssertEqual(M3UParser.guideURL(header + rows, baseURL: base)?.absoluteString, "https://tv.example.org/guide.xml")
    }
    func testCatalogBudgetRejectsRepeatedPagesAndBoundsAggregateWork() throws {
        let first = Media(id: "first", sourceID: sourceID, providerID: "1", title: "First", kind: .movie)
        let second = Media(id: "second", sourceID: sourceID, providerID: "2", title: "Second", kind: .movie)
        var budget = CatalogImportBudget(maximumPages: 2, maximumBytes: 10, maximumItems: 2)
        try budget.consume(bytes: 4)
        XCTAssertEqual(try budget.unique([first, first]).count, 1)
        XCTAssertThrowsError(try budget.unique([first]))
        XCTAssertEqual(try budget.unique([first, second]).map(\.id), ["second"])
        try budget.consume(bytes: 6)
        XCTAssertEqual(budget.responseLimit, 0)
        XCTAssertThrowsError(try budget.checkNextPage())
        var bytes = CatalogImportBudget(maximumPages: 5, maximumBytes: 10)
        try bytes.consume(bytes: 6)
        XCTAssertThrowsError(try bytes.consume(bytes: 5))
        var pages = CatalogImportBudget(maximumPages: 1)
        try pages.consume(bytes: 1)
        XCTAssertThrowsError(try pages.consume(bytes: 1))
        var items = CatalogImportBudget(maximumItems: 1)
        XCTAssertThrowsError(try items.unique([first, second]))
    }
    func testPlaylistAndGuideRejectExcessRowsWithoutReturningPartialLibraries() throws {
        let playlist = "#EXTM3U\n#EXTINF:-1,One\nhttps://tv.example/1\n#EXTINF:-1,Two\nhttps://tv.example/2"
        let base = URL(string: "https://tv.example/list.m3u")!
        XCTAssertThrowsError(try M3UParser.parse(playlist, sourceID: sourceID, baseURL: base, maximumChannels: 1))
        XCTAssertEqual(try M3UParser.parse(playlist, sourceID: sourceID, baseURL: base, maximumChannels: 2).count, 2)
        let program = "<programme channel=\"one\" start=\"20261026190000\" stop=\"20261026200000\"><title>Show</title></programme>"
        let parser = XMLTVParser(sourceID: sourceID, maximumPrograms: 1)
        XCTAssertThrowsError(try parser.parse(Data("<tv>\(program)\(program)</tv>".utf8)))
        XCTAssertEqual(try parser.parse(Data("<tv>\(program)</tv>".utf8)).count, 1)
    }
    func testCaptionTimingAndFormatting() {
        let srt = "1\r\n00:01:02,500 --> 00:01:05,000\r\nHello <i>world</i>\r\n\r\n2\r\n00:02:00,000 --> 00:02:02,000\r\nGuten Tag"
        let cues = CaptionParser.parse(srt)
        XCTAssertEqual(cues.count, 2); XCTAssertEqual(cues[0].start, 62.5); XCTAssertEqual(cues[0].text, "Hello world")
        let vtt = CaptionParser.parse("WEBVTT\n\n01:02.500 --> 01:05.000 align:center\nHello")
        XCTAssertEqual(vtt.first?.start, 62.5)
    }
    func testProgressAndEpisodeOrder() {
        let invalid = WatchProgress(seconds: .nan, duration: .infinity)
        XCTAssertEqual(invalid.seconds, 0); XCTAssertEqual(invalid.fraction, 0); XCTAssertFalse(invalid.completed)
        XCTAssertTrue(WatchProgress(seconds: 599, duration: 600).completed)
        XCTAssertFalse(WatchProgress(seconds: 10, duration: 600).completed)
        var one = Media(id: "one", sourceID: sourceID, providerID: "one", title: "One", kind: .episode); one.season = 1; one.episode = 2
        var two = one; two.id = "two"; two.season = 2; two.episode = 1
        XCTAssertEqual(Media.ordered([two, one]).map(\.id), ["one", "two"])
        XCTAssertEqual(1094.0.clock, "18:14"); XCTAssertEqual(3661.0.clock, "1:01:01")
    }
    func testDownloadPathsCannotEscapeStorageRoot() {
        let root = URL(fileURLWithPath: "/tmp/downloads")
        XCTAssertNotNil(URLPolicy.relativeFile("film.movpkg", root: root))
        XCTAssertNil(URLPolicy.relativeFile("../secret", root: root))
        XCTAssertNil(URLPolicy.relativeFile("/etc/passwd", root: root))
    }
    func testSnapshotRoundTripPreservesLocalProgress() throws {
        var snapshot = LibrarySnapshot(); snapshot.progress["episode"] = WatchProgress(seconds: 1094, duration: 2820)
        let loaded = try JSONDecoder().decode(LibrarySnapshot.self, from: JSONEncoder().encode(snapshot))
        XCTAssertEqual(loaded.progress["episode"]?.seconds, 1094)
        XCTAssertTrue(loaded.preferences.cellular)
    }
}
