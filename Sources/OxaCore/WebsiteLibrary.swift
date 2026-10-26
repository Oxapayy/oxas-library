import Foundation

struct WebsiteCatalog: Codable, Hashable {
    var id: String
    var name: String
    var type: String
    var searchable: Bool
}
struct WebsiteAddon: Codable, Hashable {
    var id: String
    var name: String
    var baseURL: URL
    var resources: [String]
    var catalogs: [WebsiteCatalog]
    var idPrefixes: [String]
    var urlPatterns: [String]
}
struct WebsiteConnection: Codable, Hashable {
    var root: URL
    var addons: [WebsiteAddon]
}
struct WebsiteCatalogPage: Codable, Identifiable, Hashable {
    var sourceID: UUID
    var addonID: String
    var catalog: WebsiteCatalog
    var cursor: String?
    var id: String { "\(sourceID):\(addonID):\(catalog.type):\(catalog.id)" }
}
struct WebsiteSeason: Codable, Hashable {
    var id: String
    var name: String
    var type: String
    var number: Int
}
struct WebsiteStream: Codable, Hashable, Identifiable {
    var id: String { url.absoluteString }
    var providerName: String?
    var languages: [String]?
    var quality: String?
    var url: URL
    var name: String
    var kind: String
    var headers: [String: String]
}
struct WebsiteItem: Codable, Hashable {
    var addonID: String
    var type: String
    var id: String
    var ids: [String: String]
    var sources: [WebsiteStream]
    var seasons: [WebsiteSeason] = []
}
struct WebsitePageResult { var media: [Media]; var programs: [TVProgram]; var page: WebsiteCatalogPage }
struct WebsiteDetails { var media: Media; var episodes: [Media] }

/// A data-only mHub v2 client. It never executes website scripts, posts watch history,
/// supplies a device identity, or attempts to bypass provider login/entitlement errors.
struct WebsiteLibrary {
    let source: MediaSource
    let endpoint: URL
    private var knownConnection: WebsiteConnection? { source.websiteConnection }
    static func root(_ url: URL) -> URL {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: true)!
        parts.fragment = nil
        if parts.path.hasSuffix("/mhub-addon.json") { parts.path = String(parts.path.dropLast("mhub-addon.json".count)) }
        else if !parts.path.hasSuffix("/") { parts.path += "/" }
        return parts.url!
    }
    private func resource(_ root: URL, segments: [String], query: [String: String] = [:]) -> URL {
        var parts = URLComponents(url: Self.root(root), resolvingAgainstBaseURL: true)!
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))
        parts.percentEncodedPath += segments.map { $0.addingPercentEncoding(withAllowedCharacters: allowed)! }.joined(separator: "/")
        var values = query; values["language"] = "en"
        parts.queryItems = (parts.queryItems ?? []).filter { entry in !values.keys.contains(entry.name) } + values.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return parts.url!
    }
    private func checked(_ url: URL) throws -> URL {
        let url = try URLPolicy.validate(url.absoluteString, allowHTTP: source.allowHTTP)
        if let originalHost = endpoint.host, let host = url.host, !URLPolicy.isLocal(originalHost), URLPolicy.isLocal(host) {
            throw OxaError.message("This website declared a private-network endpoint. It was not contacted.")
        }
        return url
    }
    private func json(_ url: URL, allowClientFetch: Bool = false) async throws -> [String: Any] {
        let data = try await HTTPClient.shared.data(checked(url), source: source, headers: ["Accept": "application/json"], publicOnly: !URLPolicy.isLocal(endpoint.host ?? ""))
        guard let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw OxaError.message("This address does not expose a supported library API. A film-cover website is not automatically an importable library.")
        }
        if result["clientFetch"] != nil {
            guard allowClientFetch, source.allowProviderFetch == true else { throw OxaError.message("This server needs provider-assisted requests. Enable them in this source’s settings, or choose another server.") }
            return try await ClientFetchExchange(source: source, endpoint: endpoint).complete(result, resolverRequest: url)
        }
        if let code = result["error"] as? String { throw OxaError.message(code == "identity_required" || code == "entitlement_required" ? "This provider requires an authorized account or subscription. No access controls were bypassed." : "The library provider could not complete this request.") }
        return result
    }
    func discover() async throws -> WebsiteConnection {
        if let knownConnection { return knownConnection }
        var pending = [Self.root(endpoint)], visited: Set<URL> = [], addons: [WebsiteAddon] = []
        while let base = pending.popLast() {
            try Task.checkCancellation()
            guard visited.insert(base).inserted else { continue }
            guard visited.count <= 24 else { throw OxaError.message("This library declares too many linked providers. Add a specific addon URL instead.") }
            let manifest = try await json(resource(base, segments: ["mhub-addon.json"]))
            guard (manifest["specVersion"] as? Int ?? 0) >= 2, let id = manifest["id"] as? String, let name = manifest["name"] as? String else {
                throw OxaError.message("This website does not provide a supported mHub v2 library. Choose its media-server type or a direct video file instead.")
            }
            if let entries = manifest["addons"] as? [[String: Any]] {
                for entry in entries where entry["enabled"] as? Bool == true {
                    if let text = entry["url"] as? String, let url = URL(string: text, relativeTo: base)?.absoluteURL { pending.append(Self.root(try checked(url))) }
                }
            } else {
                let catalogs = (manifest["catalogs"] as? [[String: Any]] ?? []).compactMap { row -> WebsiteCatalog? in
                    guard let id = row["id"] as? String, let type = row["type"] as? String, ["video", "series", "live"].contains(type) else { return nil }
                    let features = row["features"] as? [String: Any]
                    return WebsiteCatalog(id: id, name: row["name"] as? String ?? id, type: type, searchable: features?["search"] as? Bool ?? false)
                }
                addons.append(WebsiteAddon(id: id, name: name, baseURL: base, resources: manifest["resources"] as? [String] ?? [], catalogs: catalogs, idPrefixes: manifest["idPrefixes"] as? [String] ?? [], urlPatterns: manifest["urlPatterns"] as? [String] ?? []))
                for entry in manifest["requires"] as? [Any] ?? [] {
                    let row = entry as? [String: Any]
                    guard row?["enabled"] as? Bool != false, let text = entry as? String ?? row?["url"] as? String, let url = URL(string: text, relativeTo: base)?.absoluteURL else { continue }
                    pending.append(Self.root(try checked(url)))
                }
            }
        }
        guard addons.contains(where: { !$0.catalogs.isEmpty }) else { throw OxaError.message("This address has no movie, series or live-TV catalog. Add an addon that provides catalogs.") }
        return WebsiteConnection(root: Self.root(endpoint), addons: addons)
    }
    func catalog() async throws -> CatalogResult {
        let connection = try await discover()
        var media: [Media] = [], programs: [TVProgram] = [], pages: [WebsiteCatalogPage] = [], failures: [String] = []
        for addon in connection.addons {
            for catalog in addon.catalogs {
                let page = WebsiteCatalogPage(sourceID: source.id, addonID: addon.id, catalog: catalog)
                do {
                    let result = try await loadPage(page, connection: connection)
                    media += result.media; programs += result.programs; pages.append(result.page)
                } catch is CancellationError { throw CancellationError() }
                catch { failures.append("\(addon.name) · \(catalog.name)") }
            }
        }
        guard !pages.isEmpty else { throw OxaError.message("The website’s catalogs could not be loaded. It was not saved as a movie. Check the provider or try again later.") }
        let unique = Dictionary(media.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }).values.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        let warning = failures.isEmpty ? nil : "Some catalogs could not be loaded: \(failures.joined(separator: ", ")). Other catalogs remain available."
        return CatalogResult(media: unique, programs: programs, warning: warning, websiteConnection: connection, websitePages: pages)
    }
    func loadPage(_ page: WebsiteCatalogPage, connection: WebsiteConnection, search: String? = nil) async throws -> WebsitePageResult {
        guard let addon = connection.addons.first(where: { $0.id == page.addonID }) else { throw OxaError.message("This library provider is no longer available. Refresh the source.") }
        var query: [String: String] = [:]
        if let search { query["search"] = search }
        else if let cursor = page.cursor { query["cursor"] = cursor }
        let body = try await json(resource(addon.baseURL, segments: ["catalog", page.catalog.type, page.catalog.id + ".json"], query: query))
        guard let items = body["items"] as? [[String: Any]] else { throw OxaError.message("The provider returned an invalid library catalog.") }
        var next = page; next.cursor = text(body["nextCursor"])
        if next.cursor == page.cursor { next.cursor = nil }
        return WebsitePageResult(media: items.compactMap { media($0, addon: addon) }, programs: items.flatMap { programs($0, addon: addon) }, page: next)
    }
    func search(_ query: String, connection: WebsiteConnection) async throws -> [Media] {
        var media: [Media] = [], failures = 0, successes = 0
        for addon in connection.addons {
            for catalog in addon.catalogs where catalog.searchable && catalog.type != "live" {
                do { media += try await loadPage(WebsiteCatalogPage(sourceID: source.id, addonID: addon.id, catalog: catalog), connection: connection, search: query).media; successes += 1 }
                catch is CancellationError { throw CancellationError() }
                catch { failures += 1 }
            }
        }
        if successes == 0 && failures > 0 { throw OxaError.message("This website’s search is temporarily unavailable. Cached titles are still searchable.") }
        return media
    }
    func details(_ item: Media, connection: WebsiteConnection) async throws -> WebsiteDetails {
        guard let ref = item.websiteItem, let addon = connection.addons.first(where: { $0.id == ref.addonID }) else { return WebsiteDetails(media: item, episodes: []) }
        guard addon.resources.contains("item") else { return WebsiteDetails(media: item, episodes: []) }
        let body = try await json(resource(addon.baseURL, segments: ["item", ref.type, ref.id + ".json"]))
        guard var updated = media(body, addon: addon) else { throw OxaError.message("This title’s details could not be loaded.") }
        updated.id = item.id; updated.providerID = item.providerID
        updated.seriesID = item.seriesID; updated.seriesTitle = item.seriesTitle
        if item.kind == .episode { updated.kind = .episode; updated.season = item.season; updated.episode = item.episode }
        updated.subtitlePath = item.subtitlePath; updated.subtitleDelay = item.subtitleDelay
        if let original = item.websiteItem?.sources, let current = updated.websiteItem?.sources {
            var seen: Set<URL> = []
            updated.websiteItem?.sources = (original + current).filter { seen.insert($0.url).inserted }
        }
        let catalogs = body["catalogs"] as? [[String: Any]] ?? []
        updated.websiteItem?.seasons = catalogs.compactMap { row in
            guard let number = row["season"] as? Int, let id = row["id"] as? String else { return nil }
            return WebsiteSeason(id: id, name: row["name"] as? String ?? "Season \(number)", type: row["type"] as? String ?? "video", number: number)
        }
        var children = (body["children"] as? [[String: Any]] ?? []).compactMap { media($0, addon: addon, parent: updated) }
        for catalog in catalogs where catalog["season"] is Int {
            children += (catalog["items"] as? [[String: Any]] ?? []).compactMap { media($0, addon: addon, parent: updated, season: catalog["season"] as? Int) }
        }
        return WebsiteDetails(media: updated, episodes: children)
    }
    func season(_ series: Media, number: Int, connection: WebsiteConnection) async throws -> [Media] {
        guard let ref = series.websiteItem, let addon = connection.addons.first(where: { $0.id == ref.addonID }), let season = ref.seasons.first(where: { $0.number == number }) else { return [] }
        var cursor: String?, seen: Set<String> = [], episodes: [Media] = []
        repeat {
            var query: [String: String] = [:]; if let cursor { query["cursor"] = cursor }
            let body = try await json(resource(addon.baseURL, segments: ["catalog", season.type, season.id + ".json"], query: query))
            guard let rows = body["items"] as? [[String: Any]] else { throw OxaError.message("This season’s episodes could not be loaded.") }
            episodes += rows.compactMap { media($0, addon: addon, parent: series, season: number) }
            cursor = text(body["nextCursor"])
            if let cursor, !seen.insert(cursor).inserted { throw OxaError.message("This provider returned a repeated episode page. Try refreshing the source.") }
            guard seen.count <= 100 else { throw OxaError.message("This season contains too many episode pages.") }
        } while cursor != nil
        return Media.ordered(episodes)
    }
    func sources(_ item: Media, connection: WebsiteConnection) async throws -> (Media, [WebsiteStream]) {
        let detailed = try await details(item, connection: connection).media
        guard let ref = detailed.websiteItem else { throw OxaError.message("The library item has no provider reference.") }
        var candidates = ref.sources
        for addon in connection.addons where addon.resources.contains("source") {
            guard let key = addon.idPrefixes.first(where: { ref.ids[$0] != nil }), let value = ref.ids[key] else { continue }
            var query: [String: String] = [:]
            let other = ref.ids.filter { $0.key != key }.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ",")
            if !other.isEmpty { query["ids"] = other }
            do {
                let body = try await json(resource(addon.baseURL, segments: ["source", item.kind == .episode ? "series" : ref.type, "\(key):\(value).json"], query: query))
                candidates += streams(body["sources"], base: addon.baseURL).map { var row = $0; row.providerName = addon.name; return row }
            } catch is CancellationError { throw CancellationError() }
            catch { /* Other source providers can still offer alternatives. */ }
        }
        var seen: Set<URL> = []
        return (detailed, candidates.filter { seen.insert($0.url).inserted })
    }
    func playable(_ item: Media, connection: WebsiteConnection, subtitleLanguage: String = "en", selected: WebsiteStream? = nil) async throws -> Media {
        let detailed: Media, candidates: [WebsiteStream]
        if let selected { detailed = item; candidates = [selected] }
        else { (detailed, candidates) = try await sources(item, connection: connection) }
        var lastError: Error?
        for candidate in candidates where candidate.kind != "website" {
            try Task.checkCancellation()
            do {
                let resolvers = connection.addons.filter { $0.resources.contains("resolve") && $0.urlPatterns.contains { Self.matches(candidate.url.absoluteString, pattern: $0) } }
                var output: [String: Any]?
                if !resolvers.isEmpty {
                    for resolver in resolvers {
                        do { output = try await json(resource(resolver.baseURL, segments: ["resolve"], query: ["url": candidate.url.absoluteString]), allowClientFetch: true); break }
                        catch is CancellationError { throw CancellationError() }
                        catch { lastError = error }
                    }
                    guard output != nil else { throw lastError ?? OxaError.message("This server could not resolve the video.") }
                }
                let body = output ?? ["url": candidate.url.absoluteString, "headers": candidate.headers]
                guard let raw = body["url"] as? String, let rawURL = URL(string: raw, relativeTo: endpoint)?.absoluteURL else { throw OxaError.message("This server did not return a video URL.") }
                let url = try URLPolicy.validateStream(rawURL.absoluteString, source: source)
                var format = (body["format"] as? String)?.lowercased()
                if ["m3u8", "mpegurl"].contains(format ?? "") { format = "hls" }
                guard !["dash", "webm", "mkv"].contains(format ?? "") else { throw OxaError.message("This server offers a format that the native iPhone player cannot use. Choose another server.") }
                try await NetworkPolicy.validate(url, allowHTTP: source.allowHTTP, publicOnly: !URLPolicy.isLocal(endpoint.host ?? ""), allowPublicHTTP: source.allowInsecureStreams == true)
                let headers = safeHeaders(candidate.headers.merging(body["headers"] as? [String: String] ?? [:]) { _, new in new })
                if format == nil {
                    var request = URLRequest(url: url); request.httpMethod = "HEAD"
                    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
                    let probe = try await BoundedHTTP.fetch(request, limit: 1024, allowHTTP: source.allowHTTP, publicOnly: !URLPolicy.isLocal(endpoint.host ?? ""), crossOrigin: true, allowPublicHTTP: source.allowInsecureStreams == true)
                    guard (200...299).contains(probe.response.statusCode), HTTPClient.videoMIME(probe.response.mimeType) else { throw OxaError.message("This server returned a web page instead of a playable video. Choose another server.") }
                    if probe.response.mimeType?.lowercased().contains("mpegurl") == true { format = "hls" }
                }
                var result = detailed; result.stream = url; result.streamFormat = format; result.playbackHeaders = headers; result.websiteResolved = true; result.creditsStart = (body["creditsStart"] as? NSNumber)?.doubleValue
                let aliases = subtitleLanguage == "de" ? ["de", "deu", "ger"] : ["en", "eng"]
                if subtitleLanguage != "off", let caption = (body["subtitles"] as? [[String: Any]] ?? []).first(where: { aliases.contains($0["language"] as? String ?? "") }), let raw = caption["url"] as? String, let captionURL = URL(string: raw, relativeTo: url)?.absoluteURL {
                    result.subtitleURL = try checked(captionURL); result.subtitleLanguage = subtitleLanguage
                }
                return result
            } catch is CancellationError { throw CancellationError() }
            catch { lastError = error }
        }
        throw lastError ?? OxaError.message("No playable source is available for this title. Try another title or refresh this source.")
    }
    func subtitle(_ item: Media, language: String, connection: WebsiteConnection) async throws -> URL? {
        guard let ref = item.websiteItem, language != "off" else { return nil }
        for addon in connection.addons where addon.resources.contains("subtitle") {
            guard let prefix = addon.idPrefixes.first(where: { ref.ids[$0] != nil }), let value = ref.ids[prefix] else { continue }
            let body = try await json(resource(addon.baseURL, segments: ["subtitle", item.kind == .episode ? "series" : ref.type, "\(prefix):\(value).json"]))
            let aliases = language == "de" ? ["de", "deu", "ger"] : ["en", "eng"]
            for row in body["subtitles"] as? [[String: Any]] ?? [] {
                if aliases.contains(row["language"] as? String ?? ""), let text = row["url"] as? String, let url = URL(string: text, relativeTo: addon.baseURL)?.absoluteURL { return try checked(url) }
            }
        }
        return nil
    }
    static func matches(_ url: String, pattern: String) -> Bool {
        guard url.count <= 8192, pattern.count <= 1024 else { return false }
        let text = Array(url.lowercased()), glob = Array(pattern.lowercased())
        var i = 0, j = 0, lastStar: Int?, matched = 0
        while i < text.count {
            if j < glob.count && glob[j] == text[i] { i += 1; j += 1 }
            else if j < glob.count && glob[j] == "*" { lastStar = j; matched = i; j += 1 }
            else if let star = lastStar { matched += 1; i = matched; j = star + 1 }
            else { return false }
        }
        while j < glob.count && glob[j] == "*" { j += 1 }
        return j == glob.count
    }
    private func media(_ row: [String: Any], addon: WebsiteAddon, parent: Media? = nil, season: Int? = nil) -> Media? {
        guard row["directory"] == nil, let rawID = text(row["id"]), let name = row["name"] as? String else { return nil }
        let type = row["type"] as? String ?? (parent == nil ? "video" : "series")
        guard ["video", "series", "live"].contains(type) else { return nil }
        let kind: MediaKind = parent != nil || row["episode"] != nil ? .episode : type == "series" ? .series : type == "live" ? .channel : .movie
        let providerID = "\(addon.id):\(type):\(rawID)"
        var item = Media(id: "\(source.id):\(providerID)", sourceID: source.id, providerID: providerID, title: name, kind: kind)
        item.overview = row["description"] as? String ?? ""; item.year = row["year"] as? Int ?? (row["releaseDate"] as? String).flatMap { Int($0.prefix(4)) }; item.duration = ((row["runtime"] as? NSNumber)?.doubleValue ?? 0).boundedDuration
        let images = row["images"] as? [String: Any] ?? [:]
        item.poster = (images["poster"] as? String ?? images["thumbnail"] as? String ?? images["logo"] as? String).flatMap { URL(string: $0, relativeTo: addon.baseURL)?.absoluteURL }
        item.backdrop = (images["backdrops"] as? [String])?.first.flatMap { URL(string: $0, relativeTo: addon.baseURL)?.absoluteURL }
        item.group = (row["tags"] as? [String])?.first
        item.season = row["season"] as? Int ?? season; item.episode = row["episode"] as? Int
        var ids = row["ids"] as? [String: String] ?? [:]
        if let parent {
            item.seriesID = parent.providerID; item.seriesTitle = parent.title; item.poster = item.poster ?? parent.poster
            if ids.isEmpty, let parentIDs = parent.websiteItem?.ids, let season = item.season, let episode = item.episode { ids = parentIDs.mapValues { "\($0):\(season):\(episode)" } }
        }
        item.channelID = kind == .channel ? providerID : nil
        var candidates = streams(row["sources"], base: addon.baseURL)
        if let direct = row["url"] as? String, let url = URL(string: direct, relativeTo: addon.baseURL)?.absoluteURL { candidates.insert(WebsiteStream(url: url, name: name, kind: "stream", headers: row["headers"] as? [String: String] ?? [:]), at: 0) }
        item.websiteItem = WebsiteItem(addonID: addon.id, type: type, id: rawID, ids: ids, sources: candidates)
        return item
    }
    private func programs(_ row: [String: Any], addon: WebsiteAddon) -> [TVProgram] {
        guard let item = media(row, addon: addon), item.kind == .channel, let channelID = item.channelID else { return [] }
        let date = ISO8601DateFormatter()
        return (row["epg"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let title = entry["title"] as? String, let start = (entry["start"] as? String).flatMap(date.date), let end = (entry["end"] as? String).flatMap(date.date), end > start else { return nil }
            return TVProgram(id: "\(item.id):\(start.timeIntervalSince1970)", sourceID: source.id, channelID: channelID, title: title, start: start, end: end, overview: entry["description"] as? String ?? "")
        }
    }
    private func streams(_ raw: Any?, base: URL) -> [WebsiteStream] {
        (raw as? [[String: Any]] ?? []).compactMap { row in
            guard let text = row["url"] as? String, let url = URL(string: text, relativeTo: base)?.absoluteURL, ["http", "https"].contains(url.scheme ?? "") else { return nil }
            return WebsiteStream(languages: row["languages"] as? [String], quality: row["quality"] as? String, url: url, name: row["name"] as? String ?? "Stream", kind: row["kind"] as? String ?? "stream", headers: row["headers"] as? [String: String] ?? [:])
        }
    }
    private func safeHeaders(_ headers: [String: String]) -> [String: String] {
        // Never pass cookies or authorization from a provider to arbitrary player redirects.
        headers.filter { ["referer", "user-agent", "origin", "accept"].contains($0.key.lowercased()) && !$0.value.contains("\r") && !$0.value.contains("\n") }
    }
    private func text(_ value: Any?) -> String? {
        if let value = value as? String, !value.isEmpty { return value }
        if let value = value as? NSNumber { return value.stringValue }
        return nil
    }
}
