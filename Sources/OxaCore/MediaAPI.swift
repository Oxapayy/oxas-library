import Foundation

final class HTTPClient: @unchecked Sendable {
    static let shared = HTTPClient()
    func isVideo(_ url: URL, source: MediaSource) async throws -> Bool {
        var request = URLRequest(url: url); request.httpMethod = "HEAD"
        let payload = try await BoundedHTTP.fetch(request, limit: 1024, allowHTTP: source.allowHTTP, allowPublicHTTP: source.kind == .direct && source.allowInsecureStreams == true)
        guard (200...299).contains(payload.response.statusCode) else { return false }
        return Self.videoMIME(payload.response.mimeType)
    }
    static func videoMIME(_ mime: String?) -> Bool {
        let mime = mime?.lowercased() ?? ""
        return mime.hasPrefix("video/") || ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"].contains(mime)
    }
    func data(_ url: URL, source: MediaSource, headers: [String: String] = [:], method: String = "GET", body: Data? = nil, publicOnly: Bool = false, limit: Int = 64 * 1024 * 1024) async throws -> Data {
        var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = body
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let payload = try await BoundedHTTP.fetch(request, limit: limit, allowHTTP: source.allowHTTP, publicOnly: publicOnly)
        let response = payload.response
        guard (200...299).contains(response.statusCode) else {
            if response.statusCode == 401 || response.statusCode == 403 { throw OxaError.message("Access denied. Check this source’s credentials and permissions.") }
            if (300...399).contains(response.statusCode) { throw OxaError.message("This address redirects to another server. Add the final HTTPS address directly.") }
            throw OxaError.message("The server returned HTTP \(response.statusCode). Try again or check its address.")
        }
        return payload.data
    }
}
/// HTTP validators from the last playlist and guide downloads in this app
/// session. A 304 reply reuses the titles already in the library.
final class HTTPValidators: @unchecked Sendable {
    static let shared = HTTPValidators()
    private let lock = NSLock()
    private var values: [URL: (etag: String?, modified: String?)] = [:]
    private var guides: [URL: URL] = [:]
    subscript(url: URL) -> (etag: String?, modified: String?)? {
        get { lock.withLock { values[url] } }
        set { lock.withLock { values[url] = newValue } }
    }
    func guide(for playlist: URL) -> URL? { lock.withLock { guides[playlist] } }
    func setGuide(_ guide: URL?, for playlist: URL) { lock.withLock { guides[playlist] = guide } }
}
extension HTTPClient {
    /// Downloads with the validators from the last download. Returns nil when
    /// the server answers 304 Not Modified, so an unchanged playlist is not
    /// downloaded and parsed again.
    func conditional(_ url: URL, source: MediaSource, reuse: Bool) async throws -> Data? {
        var request = URLRequest(url: url)
        let known = reuse ? HTTPValidators.shared[url] : nil
        if let etag = known?.etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        if let modified = known?.modified { request.setValue(modified, forHTTPHeaderField: "If-Modified-Since") }
        let payload = try await BoundedHTTP.fetch(request, limit: 64 * 1024 * 1024, allowHTTP: source.allowHTTP)
        let response = payload.response
        if response.statusCode == 304, known != nil { return nil }
        guard (200...299).contains(response.statusCode) else {
            if response.statusCode == 401 || response.statusCode == 403 { throw OxaError.message("Access denied. Check this source’s credentials and permissions.") }
            throw OxaError.message("The server returned HTTP \(response.statusCode). Try again or check its address.")
        }
        let etag = response.value(forHTTPHeaderField: "ETag"), modified = response.value(forHTTPHeaderField: "Last-Modified")
        HTTPValidators.shared[url] = etag == nil && modified == nil ? nil : (etag, modified)
        return payload.data
    }
}
struct CatalogResult { var media: [Media]; var programs: [TVProgram] = []; var warning: String?; var websiteConnection: WebsiteConnection?; var websitePages: [WebsiteCatalogPage] = [] }
/// Per-refresh bounds supplement the transport's per-response limit. A server
/// that ignores offsets must not keep growing a library until iOS kills it.
struct CatalogImportBudget {
    let maximumPages: Int
    let maximumBytes: Int
    let maximumItems: Int
    private(set) var pages = 0
    private(set) var bytes = 0
    private var identities: Set<String> = []
    init(maximumPages: Int = 500, maximumBytes: Int = 64 * 1024 * 1024, maximumItems: Int = 100_000) {
        self.maximumPages = maximumPages; self.maximumBytes = maximumBytes; self.maximumItems = maximumItems
    }
    var responseLimit: Int { min(8 * 1024 * 1024, max(0, maximumBytes - bytes)) }
    func checkNextPage() throws {
        guard pages < maximumPages, responseLimit > 0 else { throw OxaError.message("This catalog exceeds the import limit. Add a smaller library or check the server’s pagination settings.") }
    }
    mutating func consume(bytes count: Int) throws {
        try checkNextPage()
        guard count >= 0, count <= maximumBytes - bytes else { throw OxaError.message("This catalog exceeds the import size limit. Add a smaller library.") }
        pages += 1; bytes += count
    }
    mutating func unique(_ page: [Media]) throws -> [Media] {
        let additions = page.filter { identities.insert($0.id).inserted }
        guard page.isEmpty || !additions.isEmpty else { throw OxaError.message("The server repeated a catalog page. Your saved library was kept; check the server’s pagination settings.") }
        guard identities.count <= maximumItems else { throw OxaError.message("This catalog contains too many titles. Add a smaller library.") }
        return additions
    }
}
struct MediaAPI {
    let source: MediaSource
    var credentials: Credentials
    var base: URL { URL(string: credentials.endpoint)! } // validated before storing a source
    func url(_ path: String = "", query: [String: String] = [:]) -> URL {
        let target = path.isEmpty ? base : base.appendingPathComponent(path)
        var components = URLComponents(url: target, resolvingAgainstBaseURL: true)!
        components.queryItems = (components.queryItems ?? []) + query.sorted(by: { $0.key < $1.key }).map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.url!
    }
    var authHeaders: [String: String] {
        switch source.kind {
        case .plex: return ["Accept": "application/json", "X-Plex-Token": credentials.token, "X-Plex-Client-Identifier": source.id.uuidString, "X-Plex-Product": "Oxa's Library", "X-Plex-Version": "1.0", "X-Plex-Platform": "iOS"]
        case .jellyfin, .emby: return ["Accept": "application/json", "X-Emby-Authorization": "MediaBrowser Client=\"Oxa's Library\", Device=\"iPhone\", DeviceId=\"\(source.id)\", Version=\"1.0.0\", Token=\"\(credentials.token)\""]
        case .webdav: return credentials.username.isEmpty ? [:] : ["Authorization": "Basic " + Data("\(credentials.username):\(credentials.password)".utf8).base64EncodedString()]
        default: return [:]
        }
    }
    func json(_ path: String, query: [String: String] = [:], body: [String: Any]? = nil) async throws -> [String: Any] {
        var headers = authHeaders
        if body != nil { headers["Content-Type"] = "application/json" }
        let data = try await HTTPClient.shared.data(url(path, query: query), source: source, headers: headers, method: body == nil ? "GET" : "POST", body: body.map { try JSONSerialization.data(withJSONObject: $0) })
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw OxaError.message("This address did not return the expected server API.") }; return value
    }
    func authenticate() async throws -> Credentials {
        guard source.kind == .jellyfin || source.kind == .emby else { return credentials }
        let result = try await json("Users/AuthenticateByName", body: ["Username": credentials.username, "Pw": credentials.password])
        guard let token = result["AccessToken"] as? String, let user = result["User"] as? [String: Any], let id = user["Id"] as? String else { throw OxaError.message("The server did not return a user session.") }
        var updated = credentials; updated.token = token; updated.userID = id
        updated.password = "" // store the scoped session, not the account password
        return updated
    }
    private func catalogJSON(_ path: String, query: [String: String], budget: inout CatalogImportBudget) async throws -> [String: Any] {
        try Task.checkCancellation(); try budget.checkNextPage()
        let data = try await HTTPClient.shared.data(url(path, query: query), source: source, headers: authHeaders, limit: budget.responseLimit)
        try budget.consume(bytes: data.count)
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw OxaError.message("This address did not return the expected server API.") }
        return result
    }
    func catalog(previous: (media: [Media], programs: [TVProgram])? = nil) async throws -> CatalogResult {
        var budget = CatalogImportBudget(maximumPages: source.kind == .webdav ? 2000 : 500)
        switch source.kind {
        case .jellyfin, .emby:
            var items: [Media] = []; var start = 0
            while true {
                let result = try await catalogJSON("Users/\(credentials.userID)/Items", query: ["Recursive": "true", "IncludeItemTypes": "Movie,Series,Episode", "Fields": "Overview,MediaSources,MediaStreams", "StartIndex": "\(start)", "Limit": "200", "SortBy": "SortName", "SortOrder": "Ascending"], budget: &budget)
                let rows = result["Items"] as? [[String: Any]] ?? []
                items += try budget.unique(rows.compactMap(jellyItem)); start += rows.count
                if rows.isEmpty || start >= (result["TotalRecordCount"] as? Int ?? start) { break }
                try Task.checkCancellation()
            }
            return CatalogResult(media: items)
        case .plex:
            var items: [Media] = []
            for type in ["1", "2", "4"] {
                var offset = 0
                while true {
                    let data = try await catalogJSON("library/all", query: ["type": type, "X-Plex-Container-Start": "\(offset)", "X-Plex-Container-Size": "200"], budget: &budget)
                    let box = data["MediaContainer"] as? [String: Any] ?? [:]
                    let rows = box["Metadata"] as? [[String: Any]] ?? []
                    items += try budget.unique(rows.compactMap(plexItem)); offset += rows.count
                    if rows.isEmpty || offset >= (box["totalSize"] as? Int ?? offset) { break }
                    try Task.checkCancellation()
                }
            }
            return CatalogResult(media: items)
        case .website:
            return try await WebsiteLibrary(source: source, endpoint: base).catalog()
        case .direct:
            let fileExtensions = ["mp4", "m4v", "mov", "m3u8", "mkv", "ts", "webm"]
            if !fileExtensions.contains(base.pathExtension.lowercased()) {
                let video = try await HTTPClient.shared.isVideo(base, source: source)
                if !video { return try await WebsiteLibrary(source: source, endpoint: base).catalog() }
            }
            let name = base.deletingPathExtension().lastPathComponent.removingPercentEncoding ?? source.name
            var item = Media(id: "\(source.id):direct", sourceID: source.id, providerID: "direct", title: name.isEmpty ? source.name : name, kind: .movie)
            item.stream = base
            return CatalogResult(media: [item])
        case .m3u:
            guard let data = try await HTTPClient.shared.conditional(base, source: source, reuse: previous != nil) else {
                // Unchanged playlist: keep its titles and the guide it announced.
                let guide = credentials.guideURL.isEmpty ? HTTPValidators.shared.guide(for: base) : URL(string: credentials.guideURL)
                return await withGuide(media: previous?.media ?? [], guide: guide, previous: previous?.programs)
            }
            guard let text = String(data: data, encoding: .utf8) else { throw OxaError.message("The playlist must use UTF-8 text encoding.") }
            let media = try M3UParser.parse(text, sourceID: source.id, baseURL: base)
            let announced = M3UParser.guideURL(text, baseURL: base)
            HTTPValidators.shared.setGuide(announced, for: base)
            let guide = credentials.guideURL.isEmpty ? announced : URL(string: credentials.guideURL)
            return await withGuide(media: media, guide: guide, previous: previous?.programs)
        case .xtream:
            let auth = try await json("player_api.php", query: xtreamQuery)
            guard let user = auth["user_info"] as? [String: Any], String(describing: user["auth"] ?? "0") == "1" else { throw OxaError.message("Xtream login was rejected. Check your username and password.") }
            var items: [Media] = []
            for (action, kind) in [("get_live_streams", MediaKind.channel), ("get_vod_streams", .movie), ("get_series", .series)] {
                let data = try await HTTPClient.shared.data(url("player_api.php", query: xtreamQuery.merging(["action": action]) { _, new in new }), source: source)
                guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw OxaError.message("The IPTV provider returned an invalid catalog.") }
                items += rows.compactMap { xtreamItem($0, kind: kind) }
            }
            return await withGuide(media: items, guide: credentials.guideURL.isEmpty ? url("xmltv.php", query: xtreamQuery) : URL(string: credentials.guideURL), previous: previous?.programs)
        case .webdav:
            var items: [Media] = []; var pending = [base]; var visited: Set<URL> = []
            while let directory = pending.popLast() {
                guard visited.insert(directory).inserted else { continue }
                guard visited.count <= 2000 else { throw OxaError.message("This NAS folder is too large. Add a smaller media subfolder.") }
                try budget.checkNextPage()
                var headers = authHeaders; headers["Depth"] = "1"; headers["Content-Type"] = "application/xml"
                let body = Data("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>".utf8)
                let data = try await HTTPClient.shared.data(directory, source: source, headers: headers, method: "PROPFIND", body: body, limit: budget.responseLimit)
                try budget.consume(bytes: data.count)
                for entry in try DAVParser().parse(data) {
                    guard let entryURL = URL(string: entry.href, relativeTo: directory)?.absoluteURL, URLPolicy.sameOrigin(base, entryURL), (entryURL.path == base.path || entryURL.path.hasPrefix(base.path.hasSuffix("/") ? base.path : base.path + "/")) else { continue }
                    if entry.directory {
                        if entryURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) != directory.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) { pending.append(entryURL) }
                    } else if ["mp4", "m4v", "mov", "mkv", "ts", "m3u8"].contains(entryURL.pathExtension.lowercased()) {
                        guard items.count < budget.maximumItems else { throw OxaError.message("This NAS folder contains too many titles. Add a smaller media subfolder.") }
                        var item = Media(id: "\(source.id):\(entryURL.path)", sourceID: source.id, providerID: entryURL.path, title: entry.name.isEmpty ? entryURL.deletingPathExtension().lastPathComponent : entry.name, kind: .movie)
                        item.stream = entryURL; items.append(item)
                    }
                }
                try Task.checkCancellation()
            }
            return CatalogResult(media: items)
        }
    }
    private func withGuide(media: [Media], guide: URL?, previous: [TVProgram]? = nil) async -> CatalogResult {
        guard let guide else { return CatalogResult(media: media) }
        do {
            guard let data = try await HTTPClient.shared.conditional(guide, source: source, reuse: previous != nil) else { return CatalogResult(media: media, programs: previous ?? []) }
            return CatalogResult(media: media, programs: try XMLTVParser(sourceID: source.id).parse(data))
        } catch { return CatalogResult(media: media, warning: "Channels loaded, but the program guide could not be refreshed. Check the XMLTV URL.") }
    }
    var xtreamQuery: [String: String] { ["username": credentials.username, "password": credentials.password] }
    func episodes(_ item: Media) async throws -> [Media] {
        guard source.kind == .xtream else { return [] }
        let value = try await json("player_api.php", query: xtreamQuery.merging(["action": "get_series_info", "series_id": item.providerID]) { _, new in new })
        let seasons = value["episodes"] as? [String: [[String: Any]]] ?? [:]
        return Media.ordered(seasons.flatMap { season, episodes in
            episodes.compactMap { row -> Media? in
                guard let id = string(row["id"]) else { return nil }
                var media = Media(id: "\(source.id):episode:\(id)", sourceID: source.id, providerID: id, title: row["title"] as? String ?? "Episode", kind: .episode)
                media.seriesID = item.providerID; media.seriesTitle = item.title; media.season = Int(season); media.episode = row["episode_num"] as? Int
                media.stream = url("series").appendingPathComponent(credentials.username).appendingPathComponent(credentials.password).appendingPathComponent("\(id).\(row["container_extension"] as? String ?? "mp4")")
                let info = row["info"] as? [String: Any]; media.overview = info?["plot"] as? String ?? ""; media.duration = ((info?["duration_secs"] as? NSNumber)?.doubleValue ?? 0).boundedDuration
                media.poster = item.poster; return media
            }
        })
    }
    func preparePlayback(_ item: Media, subtitleLanguage: String = "en") async throws -> Media {
        guard item.websiteItem != nil else { return item }
        let client = WebsiteLibrary(source: source, endpoint: base)
        let connection = try await client.discover()
        return try await client.playable(item, connection: connection, subtitleLanguage: subtitleLanguage)
    }
    func playbackURL(_ item: Media, download: Bool = false) async throws -> URL {
        if item.websiteItem != nil {
            let prepared = item.websiteResolved == true ? item : try await preparePlayback(item)
            guard let url = prepared.stream else { throw OxaError.message("This website did not supply a playable stream.") }
            return try URLPolicy.validateStream(url.absoluteString, source: source)
        }
        if source.kind == .jellyfin || source.kind == .emby {

            let body: [String: Any] = ["UserId": credentials.userID, "IsPlayback": true, "EnableDirectPlay": true, "EnableDirectStream": true, "EnableTranscoding": true,
                "DeviceProfile": ["Name": "Oxa iPhone", "MaxStreamingBitrate": 40_000_000,
                    "DirectPlayProfiles": [["Container": "mp4,m4v,mov", "Type": "Video", "VideoCodec": "h264,hevc", "AudioCodec": "aac,ac3,eac3,alac,mp3"]],
                    "TranscodingProfiles": [["Container": "ts", "Type": "Video", "VideoCodec": "h264", "AudioCodec": "aac", "Protocol": "hls", "Context": "Streaming", "MaxAudioChannels": "2", "MinSegments": 2]],
                    "SubtitleProfiles": [["Format": "vtt", "Method": "Hls"], ["Format": "srt", "Method": "External"]]]]
            let response = try await json("Items/\(item.providerID)/PlaybackInfo", query: ["UserId": credentials.userID], body: body)
            guard let selected = (response["MediaSources"] as? [[String: Any]])?.first else { throw OxaError.message("This server has no playable media source for this title.") }
            let container = selected["Container"] as? String ?? "mp4"
            if selected["SupportsDirectPlay"] as? Bool == true, ["mp4", "m4v", "mov"].contains(container) {
                if download { return url("Items/\(item.providerID)/Download", query: ["ApiKey": credentials.token, "api_key": credentials.token]) }
                return url("Videos/\(item.providerID)/stream.\(container)", query: ["Static": "true", "MediaSourceId": string(selected["Id"]) ?? item.providerID, "ApiKey": credentials.token, "api_key": credentials.token])
            }
            if let path = selected["TranscodingUrl"] as? String, let target = URL(string: path, relativeTo: URL(string: base.absoluteString + (base.absoluteString.hasSuffix("/") ? "" : "/")))?.absoluteURL, URLPolicy.sameOrigin(base, target) { return target }
            throw OxaError.message("No iPhone-compatible stream is available. Enable HLS transcoding on your media server.")
        }
        if source.kind == .plex {
            let data = try await json("library/metadata/\(item.providerID)")
            let box = data["MediaContainer"] as? [String: Any]; let metadata = (box?["Metadata"] as? [[String: Any]])?.first
            let variants = metadata?["Media"] as? [[String: Any]]; let variant = variants?.first
            let part = (variant?["Part"] as? [[String: Any]])?.first
            if ["mp4", "mov", "m4v"].contains(variant?["container"] as? String ?? "") {
                guard let path = part?["key"] as? String else { throw OxaError.message("The Plex server did not return a playable file.") }
                return plexURL(path)
            }
            return url("video/:/transcode/universal/start.m3u8", query: ["path": "/library/metadata/\(item.providerID)", "mediaIndex": "0", "partIndex": "0", "protocol": "hls", "directPlay": "0", "directStream": "1", "videoCodec": "h264", "audioCodec": "aac", "subtitleCodec": "webvtt", "maxVideoBitrate": "20000", "videoResolution": "1920x1080", "X-Plex-Token": credentials.token, "X-Plex-Client-Identifier": source.id.uuidString, "X-Plex-Platform": "iOS", "X-Plex-Product": "Oxa's Library"])
        }
        guard let url = item.stream else { throw OxaError.message("This item has no playable URL.") }
        _ = try URLPolicy.validateStream(url.absoluteString, source: source)
        return url
    }
    func captionURL(_ item: Media, language: String) async throws -> URL? {
        guard language != "off" else { return nil }
        if item.websiteItem != nil {
            if let url = item.subtitleURL, item.subtitleLanguage == language { return url }
            let client = WebsiteLibrary(source: source, endpoint: base)
            let connection = try await client.discover()
            return try await client.subtitle(item, language: language, connection: connection)
        }
        let languages = language == "de" ? ["de", "deu", "ger"] : ["en", "eng"]
        if source.kind == .jellyfin || source.kind == .emby {
            let result = try await json("Users/\(credentials.userID)/Items/\(item.providerID)", query: ["Fields": "MediaSources,MediaStreams"])
            guard let mediaSource = (result["MediaSources"] as? [[String: Any]])?.first else { return nil }
            let streams = mediaSource["MediaStreams"] as? [[String: Any]] ?? []
            guard let stream = streams.first(where: { ($0["Type"] as? String) == "Subtitle" && languages.contains(($0["Language"] as? String ?? "").lowercased()) && ["srt", "subrip", "vtt", "webvtt", "ass", "ssa"].contains(($0["Codec"] as? String ?? "").lowercased()) }), let index = stream["Index"] as? Int else { return nil }
            let sourceID = string(mediaSource["Id"]) ?? item.providerID
            return url("Videos/\(item.providerID)/\(sourceID)/Subtitles/\(index)/0/Stream.vtt", query: ["ApiKey": credentials.token, "api_key": credentials.token])
        }
        if source.kind == .plex {
            let result = try await json("library/metadata/\(item.providerID)")
            let box = result["MediaContainer"] as? [String: Any]
            let metadata = (box?["Metadata"] as? [[String: Any]])?.first
            let variant = (metadata?["Media"] as? [[String: Any]])?.first
            let part = (variant?["Part"] as? [[String: Any]])?.first
            let streams = part?["Stream"] as? [[String: Any]] ?? []
            if let stream = streams.first(where: { ($0["streamType"] as? Int) == 3 && languages.contains(($0["languageCode"] as? String ?? "").lowercased()) && $0["key"] is String }), let path = stream["key"] as? String { return plexURL(path) }
        }
        return nil
    }
    func plexURL(_ path: String) -> URL {
        let target = url(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        var parts = URLComponents(url: target, resolvingAgainstBaseURL: true)!; parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "X-Plex-Token", value: credentials.token)]; return parts.url!
    }
    private func jellyItem(_ row: [String: Any]) -> Media? {
        guard let id = row["Id"] as? String, let title = row["Name"] as? String else { return nil }
        let kind: MediaKind = switch row["Type"] as? String { case "Series": .series; case "Episode": .episode; default: .movie }
        var item = Media(id: "\(source.id):\(id)", sourceID: source.id, providerID: id, title: title, kind: kind)
        item.overview = row["Overview"] as? String ?? ""; item.year = row["ProductionYear"] as? Int; item.duration = (((row["RunTimeTicks"] as? NSNumber)?.doubleValue ?? 0) / 10_000_000).boundedDuration
        item.seriesID = row["SeriesId"] as? String; item.seriesTitle = row["SeriesName"] as? String; item.season = row["ParentIndexNumber"] as? Int; item.episode = row["IndexNumber"] as? Int
        let tags = row["ImageTags"] as? [String: String]
        let imageID = tags?["Primary"] != nil ? id : item.seriesID
        if let imageID { item.poster = url("Items/\(imageID)/Images/Primary", query: ["maxWidth": "600", "ApiKey": credentials.token, "api_key": credentials.token]) }
        if let imageID = item.seriesID ?? Optional(id) { item.backdrop = url("Items/\(imageID)/Images/Backdrop", query: ["maxWidth": "1200", "ApiKey": credentials.token, "api_key": credentials.token]) }
        return item
    }
    private func plexItem(_ row: [String: Any]) -> Media? {
        guard let id = string(row["ratingKey"]), let title = row["title"] as? String else { return nil }
        let kind: MediaKind = switch row["type"] as? String { case "show": .series; case "episode": .episode; default: .movie }
        var item = Media(id: "\(source.id):\(id)", sourceID: source.id, providerID: id, title: title, kind: kind)
        item.overview = row["summary"] as? String ?? ""; item.year = row["year"] as? Int; item.duration = (((row["duration"] as? NSNumber)?.doubleValue ?? 0) / 1000).boundedDuration
        item.seriesID = string(row["grandparentRatingKey"]); item.seriesTitle = row["grandparentTitle"] as? String; item.season = row["parentIndex"] as? Int; item.episode = row["index"] as? Int
        item.poster = (row["thumb"] as? String).map(plexURL); item.backdrop = (row["art"] as? String).map(plexURL)
        return item
    }
    private func xtreamItem(_ row: [String: Any], kind: MediaKind) -> Media? {
        guard let id = string(row[kind == .series ? "series_id" : "stream_id"]), let name = row["name"] as? String else { return nil }
        var item = Media(id: "\(source.id):\(kind.rawValue):\(id)", sourceID: source.id, providerID: id, title: name, kind: kind)
        item.poster = (row["stream_icon"] as? String ?? row["cover"] as? String).flatMap(URL.init(string:)); item.group = string(row["category_id"]); item.channelID = row["epg_channel_id"] as? String; item.overview = row["plot"] as? String ?? ""
        if kind != .series {
            let format = kind == .channel ? "m3u8" : (row["container_extension"] as? String ?? "mp4")
            item.stream = url(kind == .channel ? "live" : "movie").appendingPathComponent(credentials.username).appendingPathComponent(credentials.password).appendingPathComponent("\(id).\(format)")
        }
        return item
    }
    private func string(_ value: Any?) -> String? { if let value = value as? String { return value }; if let value = value as? NSNumber { return value.stringValue }; return nil }
}
