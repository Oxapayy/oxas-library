import XCTest
import Observation
import UIKit
@testable import OxasLibrary

final class PerformanceRegressionTests: XCTestCase {
    func testFrequentWritesCoalesceAndFlushRunsAwayFromMainThread() async throws {
        let writer = DiskWriteQueue(delay: 2)
        let recorded = RecordedWrites()
        for number in 0..<1_000 {
            writer.schedule(key: "library", write: { recorded.append("stale-\(number)") }, onError: { _ in XCTFail("Unexpected scheduled write error") })
        }
        try await writer.flush(key: "library") { recorded.append("latest") }
        XCTAssertEqual(recorded.values, ["latest"])
        XCTAssertFalse(recorded.wroteOnMainThread)
    }

    func testDebouncedWritePersistsWithoutAnExplicitFlush() async throws {
        let writer = DiskWriteQueue(delay: 0.03)
        let recorded = RecordedWrites(), saved = expectation(description: "Latest snapshot written")
        for number in 0..<100 {
            writer.schedule(key: "library", write: {
                recorded.append("\(number)")
                if number == 99 { saved.fulfill() }
            }, onError: { _ in XCTFail("Unexpected scheduled write error") })
        }
        await fulfillment(of: [saved], timeout: 2)
        XCTAssertEqual(recorded.values, ["99"])
    }

    func testContinuousProgressCannotPostponePersistenceForever() async throws {
        let writer = DiskWriteQueue(delay: 0.03), recorded = RecordedWrites()
        for number in 0..<30 {
            writer.schedule(key: "library", write: { recorded.append("\(number)") }, onError: { _ in XCTFail("Unexpected write error") })
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertGreaterThan(recorded.values.count, 1, "Continuous input must still save at bounded intervals")
        try await writer.flush(key: "library") { recorded.append("final") }
        XCTAssertEqual(recorded.values.last, "final")
    }

    func testFlushPreservesSeparateGuestAndAccountLibrariesAndEncryption() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let vault = Vault(); vault.namespace = "performance-test-\(UUID()):"
        let disk = try EncryptedDisk(root: folder.appendingPathComponent("state"), mediaRoot: folder.appendingPathComponent("media"), vault: vault)
        defer { try? FileManager.default.removeItem(at: folder); try? vault.remove("catalog-key") }
        let writer = DiskWriteQueue(delay: 2), source = UUID()
        var guest = LibrarySnapshot(), account = LibrarySnapshot()
        guest.media = [Media(id: "guest-title", sourceID: source, providerID: "guest", title: "Guest fixture title", kind: .movie)]
        account.media = [Media(id: "account-title", sourceID: source, providerID: "account", title: "Account fixture title", kind: .series)]
        account.progress["account-title"] = WatchProgress(seconds: 123, duration: 1200)
        account.favorites = ["account-title"]
        let stale = LibrarySnapshot(), durableGuest = guest, durableAccount = account
        writer.schedule(key: "library", write: { try disk.save(stale) }, onError: { _ in XCTFail("Unexpected write error") })
        try await writer.flush(key: "library") { try disk.save(durableGuest) }
        try await writer.flush(key: "library-account") { try disk.saveNamed(durableAccount, name: "library-account") }
        XCTAssertEqual(try disk.load().media.map(\.id), ["guest-title"])
        let restored = try XCTUnwrap(disk.loadNamed("library-account", as: LibrarySnapshot.self))
        XCTAssertEqual(restored.media.map(\.id), ["account-title"])
        XCTAssertEqual(restored.progress["account-title"]?.seconds, 123)
        XCTAssertEqual(restored.favorites, ["account-title"])
        let bytes = try Data(contentsOf: disk.root.appendingPathComponent("library-account.sealed"))
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("Account fixture title"))
    }

    @MainActor func testDownloadProgressDoesNotInvalidateCatalogObservation() {
        let state = LibraryState()
        let invalidation = RecordedWrites()
        withObservationTracking { _ = state.media.count; _ = state.sources.count } onChange: { invalidation.append("changed") }
        let item = Media(id: "download", sourceID: UUID(), providerID: "download", title: "Fixture", kind: .movie)
        state.transfers = [Transfer(id: item.id, media: item)]
        for number in 0..<1_000 { state.transfers[0].fraction = Double(number) / 1000 }
        XCTAssertTrue(invalidation.values.isEmpty, "Download updates must not redraw the catalog")
        state.media.append(item)
        XCTAssertEqual(invalidation.values, ["changed"], "Catalog edits must still notify views")
    }

    @MainActor func testLargeCatalogIndexesInvalidateForEditsAndKeepSourceScopes() {
        let source = UUID(), otherSource = UUID(), state = LibraryState()
        state.media = (0..<20_000).map { number in
            var item = Media(id: "episode-\(number)", sourceID: source, providerID: "episode-\(number)", title: "Episode \(number)", kind: .episode)
            item.seriesID = "series"; item.season = number / 100 + 1; item.episode = number % 100 + 1; return item
        }
        XCTAssertEqual(state.item("episode-19999")?.episode, 100)
        XCTAssertEqual(state.episodes(sourceID: source, seriesID: "series").count, 20_000)
        XCTAssertTrue(state.episodes(sourceID: otherSource, seriesID: "series").isEmpty)
        let start = ProcessInfo.processInfo.systemUptime
        for number in 0..<20_000 { XCTAssertNotNil(state.item("episode-\(number)")) }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 2, "Warm item lookup should be indexed rather than scanning the catalog")
        state.media[19_999].title = "Changed title"
        XCTAssertEqual(state.item("episode-19999")?.title, "Changed title")
        state.media.removeLast()
        XCTAssertNil(state.item("episode-19999"))
        XCTAssertEqual(state.episodes(sourceID: source, seriesID: "series").count, 19_999)
    }

    @MainActor func testGuideIndexInvalidatesAndDoesNotMixDifferentSources() {
        let source = UUID(), other = UUID(), now = Date(), state = LibraryState()
        state.programs = [
            TVProgram(id: "late", sourceID: source, channelID: "same-id", title: "Later", start: now.addingTimeInterval(100), end: now.addingTimeInterval(200), overview: ""),
            TVProgram(id: "other", sourceID: other, channelID: "same-id", title: "Other source", start: now, end: now.addingTimeInterval(100), overview: ""),
            TVProgram(id: "now", sourceID: source, channelID: "same-id", title: "Now", start: now.addingTimeInterval(-100), end: now.addingTimeInterval(100), overview: "")]
        XCTAssertEqual(state.guide(sourceID: source, channelID: "same-id", after: now).map(\.id), ["now", "late"])
        state.programs.removeAll { $0.id == "now" }
        XCTAssertEqual(state.guide(sourceID: source, channelID: "same-id", after: now).map(\.id), ["late"])
        XCTAssertEqual(state.guide(sourceID: other, channelID: "same-id", after: now).map(\.id), ["other"])
    }

    func testDownloadProgressPublicationIsBoundedAndResetsForRetries() {
        var gate = DownloadProgressGate(), count = 0
        for callback in 0..<1_000 { if gate.shouldPublish("file", at: Double(callback) / 1000) { count += 1 } }
        XCTAssertEqual(count, 4)
        XCTAssertTrue(gate.shouldPublish("another-file", at: 0.1))
        gate.remove("file")
        XCTAssertTrue(gate.shouldPublish("file", at: 0.999))
    }

    func testCatalogSearchRunsOutsideMainAndExcludesEpisodeRows() async throws {
        let source = UUID()
        let catalog = [
            Media(id: "series", sourceID: source, providerID: "series", title: "The Quiet Coast", kind: .series),
            Media(id: "episode", sourceID: source, providerID: "episode", title: "The Quiet Coast — Pilot", kind: .episode),
            Media(id: "movie", sourceID: source, providerID: "movie", title: "After The Rain", kind: .movie)]
        let found = try await Task.detached {
            XCTAssertFalse(isOnMainThread())
            return try CatalogSearch.find(" QUIET ", in: catalog)
        }.value
        XCTAssertEqual(found.map(\.id), ["series"])
        XCTAssertEqual(try CatalogSearch.find("", in: catalog).map(\.id), ["movie", "series"])
    }

    @MainActor func testArtworkDecodeDownsamplesBeforeTheMainThreadReceivesIt() async throws {
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 2400, height: 1600), format: format)
        let data = renderer.pngData { context in UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2400, height: 1600)) }
        let result = try await Task.detached {
            let artwork = try ArtworkRepository.decode(data, pixelSize: 600)
            return (isOnMainThread(), artwork.image.cgImage?.width ?? 0, artwork.image.cgImage?.height ?? 0, artwork.cost)
        }.value
        XCTAssertFalse(result.0)
        XCTAssertEqual(result.1, 600); XCTAssertEqual(result.2, 400)
        XCTAssertLessThan(result.3, 1_100_000)
    }

    func testCancelledArtworkWaitDoesNotConsumeAWorkerSlot() async throws {
        let permits = ArtworkPermits(limit: 1)
        try await permits.acquire()
        let waiting = Task { try await permits.acquire() }
        await Task.yield(); waiting.cancel()
        do { try await waiting.value; XCTFail("Cancelled request acquired a slot") } catch is CancellationError { }
        await permits.release()
        try await permits.acquire()
        await permits.release()
    }
}

private func isOnMainThread() -> Bool { Thread.isMainThread }

private final class RecordedWrites: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    private var main = false
    var values: [String] { lock.lock(); defer { lock.unlock() }; return entries }
    var wroteOnMainThread: Bool { lock.lock(); defer { lock.unlock() }; return main }
    func append(_ value: String) { lock.lock(); defer { lock.unlock() }; entries.append(value); main = main || Thread.isMainThread }
}
