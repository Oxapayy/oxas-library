import XCTest
@testable import OxasLibrary

final class ShelvesTests: XCTestCase {
    private let source = UUID(uuidString: "00000000-0000-0000-0000-0000000000AA")!
    private let now = Date(timeIntervalSinceReferenceDate: 800_000_000)

    private func film(_ id: String, _ title: String, _ overview: String = "") -> Media {
        Media(id: id, sourceID: source, providerID: id, title: title, kind: .movie, overview: overview)
    }
    private func done(_ ago: TimeInterval) -> WatchProgress {
        WatchProgress(seconds: 5_000, duration: 5_000, playedAt: now.addingTimeInterval(-ago), completed: true)
    }
    private var catalog: [Media] {
        [
            film("c1", "Salt Wind", "A fishing family on the coast waits for the sea to calm."),
            film("c2", "Tide Line", "A biologist maps the coast while the sea tide rewrites the shore."),
            film("c3", "Harbour Town", "A sailor returns to the harbour town on the coast by the sea."),
            film("c4", "Winter Sea", "Fishermen brave the winter sea off a cold coast."),
            film("c5", "The Lighthouse Keeper", "Alone at sea off the coast, a keeper writes to the harbour."),
            film("c6", "Glass House", "An architect builds a house on a cliff above the sea coast."),
            film("c7", "Low Water", "The sea retreats from a fishing coast for one strange week."),
            film("m1", "High Pass", "Climbers cross a mountain pass before the winter snow."),
            film("m2", "Snowline", "A ranger follows wolves along the snow line of a mountain valley."),
            film("m3", "The Last Train", "A final night shift on the mountain railway in the snow."),
            film("m4", "A Place Apart", "Two sisters return to the mountains and the snow."),
            film("o1", "The Orchard", "Three generations harvest apples in an orchard."),
            film("o2", "Kitchen Table", "A cook argues and forgives around one kitchen table."),
            film("o3", "Old Friends", "Four friends meet again at a wedding thirty years later."),
        ]
    }
    private func input(progress: [String: WatchProgress] = [:], favorites: Set<String> = []) -> ShelfInput {
        ShelfInput(media: catalog, progress: progress, favorites: favorites)
    }

    func testTokensDropStopWordsDigitsAndDiacritics() {
        XCTAssertEqual(Shelves.tokens("The Café on the Coast, 2024 — a film"), ["cafe", "coast"])
    }

    func testFranchiseKeysJoinSequelsAndSubtitlesOnly() {
        XCTAssertEqual(Shelves.franchise("Spider-Man: Brand New Day"), Shelves.franchise("Spider-Man"))
        XCTAssertEqual(Shelves.franchise("Northern Light 2"), "northern light")
        XCTAssertEqual(Shelves.franchise("The Orchard"), "orchard")
        XCTAssertNotEqual(Shelves.franchise("The Quiet Coast"), Shelves.franchise("Quiet Hours"))
        XCTAssertEqual(Shelves.franchise("Up"), "")
    }

    func testEmptyHistoryProducesNoShelves() {
        let index = SimilarityIndex(items: catalog)
        XCTAssertTrue(Shelves.watchAgain(input()).isEmpty)
        XCTAssertTrue(Shelves.becauseYouWatched(index, input()).isEmpty)
        XCTAssertTrue(Shelves.picks(index, input(), now: now).isEmpty)
        XCTAssertTrue(Shelves.readyOffline([]).isEmpty)
    }

    func testFranchiseTitlesMatchWithoutDescriptions() {
        let items = [film("a", "Spider-Man"), film("b", "Spider-Man: Brand New Day"), film("c", "Kitchen Table")]
        XCTAssertEqual(SimilarityIndex(items: items).similar("a"), ["b"])
    }

    func testUnrelatedTitlesStayUnderTheThreshold() {
        let index = SimilarityIndex(items: catalog)
        for (doc, score) in index.scores("o1") where index.docs[doc].id.hasPrefix("c") { XCTAssertLessThan(score, Shelves.threshold) }
        XCTAssertTrue(index.similar("c1").allSatisfy { $0.hasPrefix("c") || $0.hasPrefix("m") })
    }

    func testTitlesWithoutDescriptionsAreScoredByTitle() {
        let items = [film("a", "Harbour Lights"), film("b", "Harbour Lights at Night", "Boats in a harbour."), film("c", "Orchard Days")]
        XCTAssertEqual(SimilarityIndex(items: items).similar("a"), ["b"])
    }

    func testWatchAgainNeedsThreeFinishedFilmsNewestFirst() {
        XCTAssertTrue(Shelves.watchAgain(input(progress: ["c1": done(300), "c2": done(100)])).isEmpty)
        XCTAssertEqual(Shelves.watchAgain(input(progress: ["c1": done(300), "c2": done(100), "m1": done(200)])), ["c2", "m1", "c1"])
    }

    func testBecauseYouWatchedUsesOneSeedAndNeedsFiveMatches() {
        let data = input(progress: ["c1": done(100)])
        let rows = Shelves.becauseYouWatched(SimilarityIndex(items: catalog), data)
        XCTAssertEqual(rows.map(\.seedID), ["c1"])
        XCTAssertGreaterThanOrEqual(rows[0].items.count, 5)
        XCTAssertFalse(rows[0].items.contains("c1"))
        XCTAssertTrue(Shelves.becauseYouWatched(SimilarityIndex(items: catalog), input(progress: ["m4": done(50)])).isEmpty)
    }

    func testPicksNeedThreeSeedsAndEightMatches() {
        let index = SimilarityIndex(items: catalog)
        XCTAssertTrue(Shelves.picks(index, input(progress: ["c1": done(100), "c2": done(200)]), now: now).isEmpty)
        let rows = Shelves.picks(index, input(progress: ["c1": done(100), "c2": done(200)], favorites: ["m1"]), now: now)
        XCTAssertGreaterThanOrEqual(rows.count, 8)
        XCTAssertTrue(Set(rows).isDisjoint(with: ["c1", "c2", "m1"]))
    }

    func testMoreLikeThisNeedsFourMatches() {
        let index = SimilarityIndex(items: catalog)
        XCTAssertGreaterThanOrEqual(Shelves.moreLikeThis(index, "c1").count, 4)
        XCTAssertTrue(Shelves.moreLikeThis(index, "o2").isEmpty)
    }

    func testResultsAreDeterministicAndCapped() {
        let data = input(progress: ["c1": done(100)])
        XCTAssertEqual(Shelves.becauseYouWatched(SimilarityIndex(items: catalog), data).map(\.items),
                       Shelves.becauseYouWatched(SimilarityIndex(items: catalog), data).map(\.items))
        XCTAssertLessThanOrEqual(SimilarityIndex(items: catalog).similar("c1", limit: 2).count, 2)
        XCTAssertEqual(SimilarityIndex(items: (0..<7_000).map { film("x\($0)", "Title \($0)") }).docs.count, 5_000)
    }

    func testSignatureIgnoresProgressTicksButFollowsANewSeed() {
        var progress = ["c1": WatchProgress(seconds: 10, duration: 5_000, playedAt: now)]
        let before = Shelves.signature(progress: progress, favorites: [])
        progress["c1"] = WatchProgress(seconds: 40, duration: 5_000, playedAt: now)
        XCTAssertEqual(Shelves.signature(progress: progress, favorites: []), before)
        progress["c2"] = done(5)
        XCTAssertNotEqual(Shelves.signature(progress: progress, favorites: []), before)
    }

    func testEpisodesSeedTheirSeries() {
        var items = catalog
        items.append(Media(id: "s1", sourceID: source, providerID: "show", title: "Coast Stories", kind: .series, overview: "Fishing towns on the sea coast."))
        items.append(Media(id: "e1", sourceID: source, providerID: "e1", title: "Pilot", kind: .episode, seriesID: "show", seriesTitle: "Coast Stories", season: 1, episode: 1))
        let history = Shelves.history(ShelfInput(media: items, progress: ["e1": WatchProgress(seconds: 300, duration: 2_000, playedAt: now)], favorites: []))
        XCTAssertEqual(history.recent.map(\.id), ["s1"])
    }

    func testOnNowListsAiringChannelsFavouritesFirst() {
        let channel = { (id: String, title: String) in Media(id: id, sourceID: self.source, providerID: id, title: title, kind: .channel, channelID: id) }
        let program = { (channel: String, title: String, start: Double, end: Double) in
            TVProgram(id: "\(channel)-\(title)", sourceID: self.source, channelID: channel, title: title, start: self.now.addingTimeInterval(start), end: self.now.addingTimeInterval(end), overview: "")
        }
        let guide: [String: [TVProgram]] = [
            "a": [program("a", "A now", -10, 10), program("a", "A next", 10, 30)],
            "b": [program("b", "B now", -5, 5)],
            "c": [program("c", "C later", 20, 40)],
        ]
        let rows = Shelves.onNow([channel("a", "Alpha"), channel("b", "Bravo"), channel("c", "Charlie")], guide: { guide[$0.id] ?? [] }, favorites: ["b"], now: now)
        XCTAssertEqual(rows.map(\.channel.id), ["b", "a"])
        XCTAssertEqual(rows[1].next?.title, "A next")
    }

    func testLargeCatalogStaysBounded() {
        let words = "coast sea harbour mountain snow winter city rain night summer field river orchard train house".split(separator: " ").map(String.init)
        var items: [Media] = []
        for i in 0..<20_000 { items.append(film("t\(i)", "\(words[i % 15]) \(words[(i * 7) % 15]) \(i)", "\(words[(i * 3) % 15]) and \(words[(i * 11) % 15]) story \(i)")) }
        var progress: [String: WatchProgress] = [:]
        for i in 0..<6 { progress["t\(i)"] = done(Double(i) * 100) }
        let started = Date()
        let index = SimilarityIndex(items: items)
        let built = Date().timeIntervalSince(started)
        let derived = Shelves.derive(index, ShelfInput(media: items, progress: progress, favorites: []))
        let total = Date().timeIntervalSince(started)
        print(String(format: "shelves: indexed %d of %d titles in %.0f ms, shelves in %.0f ms", index.docs.count, items.count, built * 1000, (total - built) * 1000))
        XCTAssertEqual(index.docs.count, 5_000)
        XCTAssertLessThanOrEqual(derived.picks.count, 40)
    }
}
