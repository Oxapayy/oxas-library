import Foundation
import Observation

/// Keep the on-disk schema unchanged, but observe each live collection separately.
/// Download progress must not invalidate every poster, source and search result.
@MainActor @Observable final class LibraryState {
    var accountSyncFormat: Int?
    var followedSeries: [String: Set<String>]?
    var newEpisodeIDs: Set<String>?
    var sources: [MediaSource]
    var media: [Media] { didSet { mediaIndex = nil; episodeIndex = nil; catalogRevision &+= 1 } }
    private(set) var catalogRevision = 0
    var progress: [String: WatchProgress]
    var transfers: [Transfer]
    var favorites: Set<String>
    var programs: [TVProgram] { didSet { programIndex = nil } }
    var websitePages: [WebsiteCatalogPage]?
    var preferences: Preferences
    @ObservationIgnored private var mediaIndex: [String: Int]?
    @ObservationIgnored private var episodeIndex: [String: [Media]]?
    @ObservationIgnored private var programIndex: [String: [TVProgram]]?

    init(_ snapshot: LibrarySnapshot = LibrarySnapshot()) {
        accountSyncFormat = snapshot.accountSyncFormat; followedSeries = snapshot.followedSeries; newEpisodeIDs = snapshot.newEpisodeIDs
        sources = snapshot.sources; media = snapshot.media; progress = snapshot.progress; transfers = snapshot.transfers
        favorites = snapshot.favorites; programs = snapshot.programs; websitePages = snapshot.websitePages; preferences = snapshot.preferences
    }

    var snapshot: LibrarySnapshot {
        var result = LibrarySnapshot()
        result.accountSyncFormat = accountSyncFormat; result.followedSeries = followedSeries; result.newEpisodeIDs = newEpisodeIDs
        result.sources = sources; result.media = media; result.progress = progress; result.transfers = transfers
        result.favorites = favorites; result.programs = programs; result.websitePages = websitePages; result.preferences = preferences
        return result
    }

    func item(_ id: String) -> Media? {
        // Read the observed field even when the derived index is already warm.
        let items = media
        if mediaIndex == nil { mediaIndex = Dictionary(items.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first }) }
        return mediaIndex?[id].map { items[$0] }
    }

    func episodes(sourceID: UUID, seriesID: String) -> [Media] {
        let items = media
        if episodeIndex == nil {
            episodeIndex = Dictionary(grouping: items.filter { $0.kind == .episode && $0.seriesID != nil }, by: { "\($0.sourceID):\($0.seriesID!)" }).mapValues(Media.ordered)
        }
        return episodeIndex?["\(sourceID):\(seriesID)"] ?? []
    }

    func guide(sourceID: UUID, channelID: String, after date: Date) -> [TVProgram] {
        let entries = programs
        if programIndex == nil {
            programIndex = Dictionary(grouping: entries, by: { "\($0.sourceID):\($0.channelID)" }).mapValues { $0.sorted { $0.start < $1.start } }
        }
        return (programIndex?["\(sourceID):\(channelID)"] ?? []).filter { $0.end > date }
    }
}
