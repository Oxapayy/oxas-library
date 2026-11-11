import Foundation
import Observation

/// Derived shelves for the library. Everything is computed on this device from
/// signals the library already has (titles, descriptions, watch progress, the
/// watchlist, saved downloads and the guide). Nothing is stored, synced or sent.
enum Shelves {
    static let threshold = 0.1
    static let franchiseBonus = 0.35
    static let candidateLimit = 5_000

    private static let stopWords: Set<String> = Set("""
    the and for with from that this these those into onto over under after before about \
    his her hers their theirs they them she him its our ours you your yours who whom whose \
    what when where while which why how are was were been being has have had but not nor \
    all any each every one two three some such than then there here out off very more most \
    own other only just also again once upon will would could should can may might must \
    film films movie movies series season episode episodes part new
    """.split(separator: " ").map(String.init))

    private static func plain(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
    }

    /// Folds simple English plurals so "mountains" meets "mountain".
    private static func stem(_ token: String) -> String {
        if token.count > 4, token.hasSuffix("ies") { return String(token.dropLast(3)) + "y" }
        if token.count > 4, token.hasSuffix("s"), !token.hasSuffix("ss") { return String(token.dropLast()) }
        return token
    }

    static func tokens(_ text: String) -> [String] {
        plain(text).split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }.map(String.init)
            .filter { $0.count >= 3 && !stopWords.contains($0) && !$0.allSatisfy(\.isNumber) }
            .map(stem)
    }

    /// "Spider-Man: Brand New Day" and "Spider-Man" share the key "spider-man".
    static func franchise(_ title: String) -> String {
        var head = plain(title)
        if let range = head.range(of: #"\s*[:–—]\s*|\s+-\s+"#, options: .regularExpression) { head = String(head[..<range.lowerBound]) }
        if head.hasPrefix("the ") { head = String(head.dropFirst(4)) }
        head = head.replacingOccurrences(of: #"\s+(part\s+)?([0-9]+|ii|iii|iv|v|vi)$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return head.filter { $0.isLetter || $0.isNumber }.count >= 3 ? head : ""
    }
}

/// TF-IDF vectors over titles and descriptions with an inverted index, so a query
/// only visits titles that share at least one word with the seed.
struct SimilarityIndex: Sendable {
    struct Doc: Sendable {
        let id: String
        let title: String
        let key: String
        let terms: [String: Double]
        let norm: Double
    }
    private struct Posting: Sendable { let doc: Int; let weight: Double }
    private(set) var docs: [Doc] = []
    private var position: [String: Int] = [:]
    private var postings: [String: [Posting]] = [:]

    init(items: [Media], limit: Int = Shelves.candidateLimit) {
        let pool = Array(items.lazy.filter { $0.kind == .movie || $0.kind == .series }.prefix(limit))
        var counts: [[String: Int]] = [], df: [String: Int] = [:]
        counts.reserveCapacity(pool.count)
        for item in pool {
            var row: [String: Int] = [:]
            for token in Shelves.tokens(item.title) { row[token, default: 0] += 1 }
            for token in Shelves.tokens(item.overview) { row[token, default: 0] += 1 }
            for token in row.keys { df[token, default: 0] += 1 }
            counts.append(row)
        }
        let total = Double(pool.count)
        for (offset, item) in pool.enumerated() {
            var terms: [String: Double] = [:], sum = 0.0
            for (token, count) in counts[offset] {
                let frequency = df[token] ?? 1
                // A word found in one title only can never be shared; it still counts
                // toward length, at half weight, so tiny overlaps stay small.
                let weight = (1 + log(Double(count))) * log(1 + total / Double(frequency)) * (frequency == 1 ? 0.5 : 1)
                terms[token] = weight
                sum += weight * weight
            }
            position[item.id] = docs.count
            for (token, weight) in terms { postings[token, default: []].append(Posting(doc: docs.count, weight: weight)) }
            docs.append(Doc(id: item.id, title: item.title, key: Shelves.franchise(item.title), terms: terms, norm: sum > 0 ? sum.squareRoot() : 1))
        }
    }

    func contains(_ id: String) -> Bool { position[id] != nil }

    /// Scores every other catalog title against one seed title.
    func scores(_ id: String) -> [Int: Double] {
        guard let seedIndex = position[id] else { return [:] }
        let seed = docs[seedIndex]
        var out: [Int: Double] = [:]
        for (token, weight) in seed.terms {
            for posting in postings[token] ?? [] where posting.doc != seedIndex { out[posting.doc, default: 0] += weight * posting.weight }
        }
        for (doc, dot) in out { out[doc] = dot / (seed.norm * docs[doc].norm) }
        if !seed.key.isEmpty {
            for (doc, other) in docs.enumerated() where doc != seedIndex && other.key == seed.key { out[doc, default: 0] += Shelves.franchiseBonus }
        }
        return out
    }

    func ranked(_ scores: [Int: Double], excluding: Set<String>, limit: Int) -> [String] {
        scores.filter { $0.value >= Shelves.threshold && !excluding.contains(docs[$0.key].id) }
            .sorted { $0.value != $1.value ? $0.value > $1.value : docs[$0.key].title.localizedStandardCompare(docs[$1.key].title) == .orderedAscending }
            .prefix(limit).map { docs[$0.key].id }
    }

    func similar(_ id: String, excluding: Set<String> = [], limit: Int = 40) -> [String] {
        ranked(scores(id), excluding: excluding, limit: limit)
    }
}

struct ShelfInput: Sendable {
    var media: [Media]
    var progress: [String: WatchProgress]
    var favorites: Set<String>
}

struct BecauseShelf: Sendable, Identifiable {
    var seedID: String
    var seedTitle: String
    var items: [String]
    var id: String { seedID }
}

struct DerivedShelves: Sendable {
    var picks: [String] = []
    var because: [BecauseShelf] = []
    var watchAgain: [String] = []
}

extension Shelves {
    struct History: Sendable {
        struct Entry: Sendable { var id: String; var title: String; var at: Date; var done: Bool }
        var recent: [Entry]
        var watchlist: [String]
        var seen: Set<String>
    }

    /// Episodes stand for their series, so history holds catalog titles only.
    static func history(_ input: ShelfInput) -> History {
        var byID: [String: Media] = [:], series: [String: Media] = [:]
        for item in input.media {
            byID[item.id] = item
            if item.kind == .series { series["\(item.sourceID):\(item.providerID)"] = item }
        }
        var latest: [String: History.Entry] = [:]
        for (id, progress) in input.progress where progress.seconds > 0 || progress.completed {
            guard let item = byID[id], item.kind != .channel else { continue }
            let title = item.kind == .episode ? item.seriesID.flatMap { series["\(item.sourceID):\($0)"] } : item
            guard let title else { continue }
            let done = progress.completed && item.kind == .movie
            if let previous = latest[title.id] {
                latest[title.id] = History.Entry(id: title.id, title: title.title, at: max(previous.at, progress.playedAt), done: previous.done || done)
            } else {
                latest[title.id] = History.Entry(id: title.id, title: title.title, at: progress.playedAt, done: done)
            }
        }
        let recent = latest.values.sorted { $0.at != $1.at ? $0.at > $1.at : $0.id < $1.id }
        let watchlist = input.media.filter { input.favorites.contains($0.id) && ($0.kind == .movie || $0.kind == .series) }.map(\.id)
        return History(recent: recent, watchlist: watchlist, seen: Set(latest.keys))
    }

    /// Changes when a title is started, finished or saved; a progress tick does not.
    static func signature(progress: [String: WatchProgress], favorites: Set<String>) -> String {
        let recent = progress.filter { $0.value.seconds > 0 || $0.value.completed }
            .sorted { $0.value.playedAt != $1.value.playedAt ? $0.value.playedAt > $1.value.playedAt : $0.key < $1.key }
            .prefix(12).map { "\($0.key)=\($0.value.completed)" }
        return recent.joined(separator: ",") + "|" + favorites.sorted().joined(separator: ",")
    }

    static func watchAgain(_ input: ShelfInput, limit: Int = 40) -> [String] {
        let done = input.media.compactMap { item -> (String, Date)? in
            guard item.kind == .movie, let progress = input.progress[item.id], progress.completed else { return nil }
            return (item.id, progress.playedAt)
        }.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0 < $1.0 }
        return done.count >= 3 ? Array(done.prefix(limit).map(\.0)) : []
    }

    static func becauseYouWatched(_ index: SimilarityIndex, _ input: ShelfInput, history: History? = nil, max: Int = 2, limit: Int = 40) -> [BecauseShelf] {
        let history = history ?? Self.history(input)
        var titles: [String: String] = [:]
        for entry in history.recent { titles[entry.id] = entry.title }
        var seeds: [String] = [], picked: Set<String> = []
        for id in history.recent.map(\.id) where index.contains(id) && picked.insert(id).inserted { seeds.append(id) }
        var out: [BecauseShelf] = []
        for seed in seeds where out.count < max {
            let rows = index.similar(seed, excluding: history.seen.union([seed]), limit: limit)
            if rows.count >= 5 { out.append(BecauseShelf(seedID: seed, seedTitle: titles[seed] ?? "", items: rows)) }
        }
        return out
    }

    static func picks(_ index: SimilarityIndex, _ input: ShelfInput, history: History? = nil, now: Date = .now, limit: Int = 40) -> [String] {
        let history = history ?? Self.history(input)
        var weights: [String: Double] = [:]
        for id in history.watchlist { weights[id] = 1 }
        for entry in history.recent {
            let days = Swift.max(0, now.timeIntervalSince(entry.at) / 86_400)
            let weight = (entry.done ? 0.8 : 0.6) / (1 + days / 30)
            weights[entry.id] = Swift.max(weights[entry.id] ?? 0, weight)
        }
        let seeds = weights.filter { index.contains($0.key) }
        guard seeds.count >= 3, let top = seeds.values.max(), top > 0 else { return [] }
        var total: [Int: Double] = [:]
        for (id, weight) in seeds {
            for (doc, score) in index.scores(id) where score >= threshold { total[doc, default: 0] += score * weight }
        }
        for (doc, value) in total { total[doc] = value / top }
        let rows = index.ranked(total, excluding: history.seen.union(history.watchlist), limit: limit)
        return rows.count >= 8 ? rows : []
    }

    static func moreLikeThis(_ index: SimilarityIndex, _ id: String, limit: Int = 20) -> [String] {
        let rows = index.similar(id, excluding: [id], limit: limit)
        return rows.count >= 4 ? rows : []
    }

    static func readyOffline(_ transfers: [Transfer]) -> [Media] {
        transfers.filter { $0.state == .ready }.map(\.media)
    }

    struct Airing: Identifiable {
        var channel: Media
        var program: TVProgram
        var next: TVProgram?
        var id: String { channel.id }
    }

    /// Channels with a programme on air now, favourites first, with what follows.
    static func onNow(_ channels: [Media], guide: (Media) -> [TVProgram], favorites: Set<String>, now: Date = .now) -> [Airing] {
        channels.compactMap { channel -> Airing? in
            let list = guide(channel)
            guard let program = list.first(where: { $0.start <= now && $0.end > now }) else { return nil }
            return Airing(channel: channel, program: program, next: list.filter { $0.start >= program.end }.min { $0.start < $1.start })
        }.sorted {
            let a = favorites.contains($0.channel.id), b = favorites.contains($1.channel.id)
            return a != b ? a : $0.channel.title.localizedStandardCompare($1.channel.title) == .orderedAscending
        }
    }

    static func derive(_ index: SimilarityIndex?, _ input: ShelfInput) -> DerivedShelves {
        let history = Self.history(input)
        var result = DerivedShelves(watchAgain: watchAgain(input))
        if let index {
            result.because = becauseYouWatched(index, input, history: history)
            result.picks = picks(index, input, history: history)
        }
        return result
    }
}

/// Holds the derived shelves for the views. The index is rebuilt only when the
/// catalog changes, the shelves only when a seed or the watchlist changes, and
/// both are computed away from the main actor.
@MainActor @Observable final class ShelfModel {
    private(set) var index: SimilarityIndex?
    private(set) var shelves = DerivedShelves()
    @ObservationIgnored private var indexKey = ""
    @ObservationIgnored private var shelfKey = ""

    func update(catalog: [Media], progress: [String: WatchProgress], favorites: Set<String>, revision: Int, epoch: UUID) async {
        let newIndexKey = "\(epoch)-\(revision)"
        let newShelfKey = newIndexKey + "|" + Shelves.signature(progress: progress, favorites: favorites)
        guard newShelfKey != shelfKey || index == nil else { return }
        let input = ShelfInput(media: catalog, progress: progress, favorites: favorites)
        let reuse = newIndexKey == indexKey ? index : nil
        let work = Task.detached(priority: .utility) { () -> (SimilarityIndex, DerivedShelves) in
            let built = reuse ?? SimilarityIndex(items: input.media)
            try Task.checkCancellation()
            return (built, Shelves.derive(built, input))
        }
        guard let (built, derived) = try? await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() }) else { return }
        // A newer update superseded this one; never let its older result win.
        guard !Task.isCancelled else { return }
        index = built
        indexKey = newIndexKey
        shelves = derived
        shelfKey = newShelfKey
    }
}
