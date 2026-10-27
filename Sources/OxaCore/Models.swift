import Foundation

enum SourceKind: String, Codable, CaseIterable, Identifiable {
    case website = "Library URL", jellyfin = "Jellyfin", plex = "Plex", emby = "Emby", webdav = "NAS / WebDAV", direct = "Video URL", m3u = "M3U playlist", xtream = "Xtream Codes"
    var id: String { rawValue }
    var isTV: Bool { self == .m3u || self == .xtream }
    var icon: String { switch self { case .jellyfin, .plex, .emby: "server.rack"; case .webdav: "externaldrive"; case .website: "rectangle.stack"; case .direct: "link"; case .m3u, .xtream: "tv" } }
}
struct MediaSource: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var kind: SourceKind
    var host: String
    var allowHTTP = false
    var refreshedAt: Date?
    var websiteConnection: WebsiteConnection?
    var allowProviderFetch: Bool?
    var allowInsecureStreams: Bool?
}
struct Credentials: Codable {
    var endpoint: String
    var username = ""
    var password = ""
    var token = ""
    var userID = ""
    var guideURL = ""
}
enum MediaKind: String, Codable { case movie, series, episode, channel, folder }
struct Media: Codable, Identifiable, Hashable {
    var id: String
    var sourceID: UUID
    var providerID: String
    var title: String
    var kind: MediaKind
    var overview = ""
    var year: Int?
    var duration: Double = 0
    var poster: URL?
    var backdrop: URL?
    var stream: URL?
    var seriesID: String?
    var seriesTitle: String?
    var season: Int?
    var episode: Int?
    var group: String?
    var channelID: String?
    var subtitleURL: URL?
    var subtitleLanguage: String?
    var subtitlePath: String?
    var websiteItem: WebsiteItem?
    var websiteResolved: Bool?
    var playbackHeaders: [String: String]?
    var streamFormat: String?
    var downloadPreference: WebsiteStream?
    var cloudIdentity: String?
    var creditsStart: Double?
    var subtitleDelay: Double = 0
    var displayTitle: String { kind == .episode ? (seriesTitle ?? title) : title }
    var episodeLabel: String { if let season, let episode { return "S\(season) · E\(episode)" }; return kind == .channel ? "Live TV" : kind.rawValue.capitalized }
    static func ordered(_ items: [Media]) -> [Media] {
        items.sorted { ($0.season ?? 0, $0.episode ?? 0, $0.title) < ($1.season ?? 0, $1.episode ?? 0, $1.title) }
    }
}
struct WatchProgress: Codable {
    var seconds: Double
    var duration: Double
    var completed: Bool
    var playedAt: Date
    var fraction: Double { duration > 0 ? min(max(seconds / duration, 0), 1) : 0 }
    init(seconds: Double, duration: Double, playedAt: Date = .now, completed: Bool = false) {
        self.seconds = seconds.isFinite ? max(0, seconds) : 0
        self.duration = duration.isFinite ? max(0, duration) : 0
        self.completed = completed || (self.duration > 0 && self.seconds >= self.duration - min(30, self.duration * 0.03))
        self.playedAt = playedAt
    }
}
enum TransferState: String, Codable { case queued, downloading, ready, failed, cancelled }
struct Transfer: Codable, Identifiable {
    var id: String
    var media: Media
    var state: TransferState = .queued
    var fraction: Double = 0
    var bytes: Int64 = 0
    var relativePath: String?
    var systemRelativePath: String?
    var error: String?
}
struct TVProgram: Codable, Identifiable {
    var id: String
    var sourceID: UUID
    var channelID: String
    var title: String
    var start: Date
    var end: Date
    var overview: String
    var isNow: Bool { start <= .now && end > .now }
}
struct Preferences: Codable {
    var autoplay = true
    var cellular = true
    var subtitleLanguage = "en"
    var audioLanguage = "en"
    var externalMetadata = false
}
struct LibrarySnapshot: Codable {
    var accountSyncFormat: Int?
    var followedSeries: [String: Set<String>]?
    var newEpisodeIDs: Set<String>?
    var sources: [MediaSource] = []
    var media: [Media] = []
    var progress: [String: WatchProgress] = [:]
    var transfers: [Transfer] = []
    var favorites: Set<String> = []
    var programs: [TVProgram] = []
    var websitePages: [WebsiteCatalogPage]?
    var preferences = Preferences()
}
struct Playback: Identifiable {
    var id = UUID()
    var revision = UUID()
    var selectedSource: WebsiteStream?
    var media: Media
    var url: URL
}
enum OxaError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): text } }
}
extension Double {
    var boundedDuration: Double { isFinite && self >= 0 && self <= 31_536_000 ? self : 0 }
    var clock: String { let total = Int(boundedDuration); return total >= 3600 ? String(format: "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60) : String(format: "%d:%02d", total / 60, total % 60) }
}
enum URLPolicy {
    static func validate(_ text: String, allowHTTP: Bool) throws -> URL {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), let host = url.host, !host.isEmpty,
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil else {
            throw OxaError.message("Enter a valid HTTP or HTTPS URL without embedded login credentials.")
        }
        if url.scheme?.lowercased() == "http" && (!allowHTTP || !isLocal(host)) {
            throw OxaError.message("Use HTTPS. Local HTTP requires Allow local HTTP; internet servers require HTTPS.")
        }
        return url
    }
    static func validateStream(_ text: String, source: MediaSource) throws -> URL {
        if let url = URL(string: text), url.scheme?.lowercased() == "http", source.allowInsecureStreams == true {
            var secure = URLComponents(url: url, resolvingAgainstBaseURL: true)!; secure.scheme = "https"
            _ = try validate(secure.url!.absoluteString, allowHTTP: false)
            return url
        }
        do { return try validate(text, allowHTTP: source.allowHTTP) }
        catch { if URL(string: text)?.scheme == "http" { throw OxaError.message("This stream uses unencrypted HTTP. Enable Allow HTTP streams for this source to play it, or choose an HTTPS server.") }; throw error }
    }
    static func isLocal(_ host: String) -> Bool {
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".local") || !host.contains(".") && !host.contains(":") { return true }
        if host == "::1" || host.hasPrefix("fe80:") || host.hasPrefix("fc") && host.contains(":") || host.hasPrefix("fd") && host.contains(":") { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        let parts = octets.compactMap { Int($0) }
        guard octets.count == 4, parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        return parts[0] == 10 || parts[0] == 127 || parts[0] == 192 && parts[1] == 168 || parts[0] == 172 && (16...31).contains(parts[1]) || parts[0] == 169 && parts[1] == 254
    }
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        func port(_ u: URL) -> Int { u.port ?? (u.scheme == "https" ? 443 : 80) }
        return a.scheme?.lowercased() == b.scheme?.lowercased() && a.host?.lowercased() == b.host?.lowercased() && port(a) == port(b)
    }
    static func relativeFile(_ path: String, root: URL) -> URL? {
        guard !path.hasPrefix("/") else { return nil }
        let candidate = root.appendingPathComponent(path).standardizedFileURL
        return candidate.path.hasPrefix(root.standardizedFileURL.path + "/") ? candidate : nil
    }
}
