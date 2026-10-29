import SwiftUI
import Observation
import AVFoundation

@MainActor @Observable final class AppStore {
    var state = LibraryState()
    var accountID: UUID?
    var account: AccountController!
    var libraryEpoch = UUID()
    var error: String?
    var notices: [UUID: String] = [:]
    var refreshing: Set<UUID> = []
    var loadingWebsitePages: Set<String> = []
    var loadingWebsiteDetails: Set<String> = []
    var playback: Playback?
    var sourceSelection: SourceSelection?
    var pendingPlayback: Playback?
    var preparingPlayback = false
    var selectedTab = 0
    var showAddSource = false
    var preview = false
    var storageAvailable = true
    var downloads: DownloadManager!
    let vault: Vault
    let identityVault: Vault
    var disk: EncryptedDisk?
    @ObservationIgnored let persistence = DiskWriteQueue()
    var availableUpdate: AppRelease?
    @ObservationIgnored private var updateCheckedAt: Date?
    init(disk injectedDisk: EncryptedDisk? = nil, vault: Vault = Vault(), identityVault: Vault = Vault(), startServices: Bool = true) {
        self.vault = vault; self.identityVault = identityVault
        do {
            let disk = try injectedDisk ?? EncryptedDisk(); self.disk = disk
            if let data = try identityVault.read("active-account"), let owner = try? JSONDecoder().decode(AccountIdentity.self, from: data) {
                accountID = owner.id; vault.namespace = owner.id.uuidString + ":"
                state = LibraryState(try disk.loadNamed("library-\(owner.id)", as: LibrarySnapshot.self) ?? LibrarySnapshot())
            } else { state = LibraryState(try disk.load()) }
        }
        catch { storageAvailable = false; self.error = "The saved library could not be opened. Your data has been preserved. \(error.localizedDescription)" }
        if startServices { downloads = DownloadManager(store: self); account = AccountController(store: self) }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-reset") { state = LibraryState(); save() }
        if ProcessInfo.processInfo.arguments.contains("--ui-test-episode-player") {
            let source = MediaSource(name: "Local playback fixture", kind: .direct, host: "127.0.0.1", allowHTTP: true)
            let endpoint = "http://127.0.0.1:8789/test-stream.mp4"
            try? vault.save(Credentials(endpoint: endpoint), id: source.id)
            state.sources = [source]
            var first = Media(id: "fixture-episode-1", sourceID: source.id, providerID: "episode-1", title: "First Episode", kind: .episode, duration: 24)
            first.stream = URL(string: endpoint); first.seriesID = "fixture-series"; first.seriesTitle = "The Quiet Coast"; first.season = 1; first.episode = 1; first.creditsStart = 15
            var next = first; next.id = "fixture-episode-2"; next.providerID = "episode-2"; next.title = "Second Episode"; next.episode = 2
            state.media = [first, next]
            Task { await self.play(first) }
        }
        #endif
        if ProcessInfo.processInfo.arguments.contains("--preview-library") { enablePreview() }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-large-library") { enablePerformanceFixture() }
        #endif
    }
    var sources: [MediaSource] { state.sources }
    var catalog: [Media] { state.media }
    var continueWatching: [Media] {
        let candidates = state.progress.filter { !$0.value.completed && $0.value.seconds > 0 }.sorted { $0.value.playedAt > $1.value.playedAt }
        var seen: Set<String> = []
        return candidates.compactMap { id, _ in
            guard let item = media(id) else { return nil }
            let identity = "\(item.sourceID):\(item.seriesID ?? item.providerID)"
            return seen.insert(identity).inserted ? item : nil
        }
    }
    var newEpisodes: [Media] {
        var seen: Set<String> = []
        return Media.ordered(catalog.filter { (state.newEpisodeIDs ?? []).contains($0.id) && (state.progress[$0.id]?.seconds ?? 0) == 0 }).filter { seen.insert("\($0.sourceID):\($0.seriesID ?? $0.id)").inserted }
    }
    private func checkNewEpisodes(_ source: MediaSource, context: UUID) async {
        let watched = catalog.filter { $0.sourceID == source.id && $0.kind == .episode && (state.progress[$0.id]?.seconds ?? 0) > 0 }
        let seriesIDs = Set(watched.compactMap(\.seriesID))
        for series in Array(catalog.filter { $0.sourceID == source.id && $0.kind == .series && seriesIDs.contains($0.providerID) }.prefix(100)) {
            do {
                var episodes: [Media]
                let api = try api(source.id)
                if source.kind == .website {
                    let client = WebsiteLibrary(source: api.source, endpoint: api.base)
                    let connection = try await client.discover()
                    let detail = try await client.details(series, connection: connection)
                    episodes = detail.episodes
                    for season in (detail.media.websiteItem?.seasons ?? []) { episodes += try await client.season(detail.media, number: season.number, connection: connection) }
                } else if source.kind == .xtream { episodes = try await api.episodes(series) }
                else { episodes = self.episodes(series) }
                guard context == libraryEpoch else { return }
                let key = "\(source.id):\(series.providerID)"
                let prior = state.followedSeries?[key] ?? Set(self.episodes(series).map(\.id))
                let last = watched.filter { $0.seriesID == series.providerID }.map { ($0.season ?? 0) * 100000 + ($0.episode ?? 0) }.max() ?? 0
                let added = episodes.filter { !prior.contains($0.id) && (state.progress[$0.id]?.seconds ?? 0) == 0 && (($0.season ?? 0) * 100000 + ($0.episode ?? 0) > last || $0.episode == nil) }
                state.newEpisodeIDs = (state.newEpisodeIDs ?? []).union(added.map(\.id))
                if state.followedSeries == nil { state.followedSeries = [:] }
                state.followedSeries?[key] = prior.union(episodes.map(\.id))
                mergeMedia(episodes)
            } catch { /* A failed check keeps the last successful episode state. */ }
        }
        save()
    }
    func media(_ id: String) -> Media? { state.item(id) ?? state.transfers.first { $0.id == id }?.media }
    func source(_ id: UUID) -> MediaSource? { sources.first { $0.id == id } }
    func persistSnapshot() async throws {
        guard !preview, storageAvailable, let disk else { throw OxaError.message("Local storage is unavailable.") }
        let snapshot = state.snapshot, name = accountID.map { "library-\($0)" }
        try await persistence.flush(key: name ?? "library") {
            if let name { try disk.saveNamed(snapshot, name: name) } else { try disk.save(snapshot) }
        }
    }
    func save() {
        guard !preview, storageAvailable, let disk else { return }
        let snapshot = state.snapshot, name = accountID.map { "library-\($0)" }, context = libraryEpoch
        persistence.schedule(key: name ?? "library", write: {
            if let name { try disk.saveNamed(snapshot, name: name) } else { try disk.save(snapshot) }
        }, onError: { [weak self] error in
            Task { @MainActor in
                guard let self, self.libraryEpoch == context else { return }
                self.error = "Could not save your library. \(error.localizedDescription)"
            }
        })
    }
    func saveForBackground() {
        guard !preview, storageAvailable else { return }
        let task = UIApplication.shared.beginBackgroundTask(withName: "Save library")
        Task {
            defer { if task != .invalid { UIApplication.shared.endBackgroundTask(task) } }
            do { try await persistSnapshot(); try await account?.persistJournal() }
            catch { self.error = "Could not save your library. \(error.localizedDescription)" }
        }
    }
    func api(_ id: UUID) throws -> MediaAPI {
        guard let source = source(id) else { throw OxaError.message("This source was removed. Add it again to stream this title.") }
        return MediaAPI(source: source, credentials: try vault.credentials(id))
    }
    func addSource(name: String, kind: SourceKind, credentials: Credentials, allowHTTP: Bool, existing: MediaSource? = nil, allowInsecureStreams: Bool = false) async throws {
        let context = libraryEpoch
        guard storageAvailable, !preview else { throw OxaError.message("Leave Preview Library before adding your server.") }
        var inputPolicy = MediaSource(name: name, kind: kind, host: "", allowHTTP: allowHTTP); inputPolicy.allowInsecureStreams = allowInsecureStreams
        let url = try kind == .direct ? URLPolicy.validateStream(credentials.endpoint, source: inputPolicy) : URLPolicy.validate(credentials.endpoint, allowHTTP: allowHTTP)
        if !credentials.guideURL.isEmpty { _ = try URLPolicy.validate(credentials.guideURL, allowHTTP: allowHTTP) }
        var source = MediaSource(name: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? kind.rawValue : name.trimmingCharacters(in: .whitespacesAndNewlines), kind: kind, host: url.host ?? "", allowHTTP: allowHTTP)
        source.allowInsecureStreams = allowInsecureStreams
        if let existing { source.id = existing.id; source.allowProviderFetch = existing.allowProviderFetch }
        let api = MediaAPI(source: source, credentials: credentials)
        let authenticated = credentials.password.isEmpty && !credentials.token.isEmpty ? credentials : try await api.authenticate()
        let result = try await MediaAPI(source: source, credentials: authenticated).catalog()
        try Task.checkCancellation()
        guard context == libraryEpoch else { throw CancellationError() }
        try vault.save(authenticated, id: source.id)
        source.refreshedAt = .now
        if let connection = result.websiteConnection { source.kind = .website; source.websiteConnection = connection; if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || source.name == SourceKind.direct.rawValue { source.name = source.host } }
        state.websitePages = (state.websitePages ?? []).filter { $0.sourceID != source.id } + result.websitePages
        state.sources.removeAll { $0.id == source.id }; state.media.removeAll { $0.sourceID == source.id }; state.programs.removeAll { $0.sourceID == source.id }
        state.sources.append(source); state.media += result.media; state.programs += result.programs
        notices[source.id] = result.warning; save(); account?.sourceChanged(source)
    }
    func refresh(_ source: MediaSource) async {
        let context = libraryEpoch
        guard !preview, !refreshing.contains(source.id) else { return }
        refreshing.insert(source.id); defer { refreshing.remove(source.id) }
        do {
            var client = try api(source.id)
            var freshSource = client.source; freshSource.websiteConnection = nil
            client = MediaAPI(source: freshSource, credentials: client.credentials)
            if state.followedSeries == nil { state.followedSeries = [:] }
            for item in catalog where item.sourceID == source.id && item.kind == .episode && (state.progress[item.id]?.seconds ?? 0) > 0 {
                if let seriesID = item.seriesID {
                    let key = "\(source.id):\(seriesID)"
                    if state.followedSeries?[key] == nil { let known = Set(catalog.filter { $0.sourceID == source.id && $0.seriesID == seriesID && $0.kind == .episode }.map(\.id)); state.followedSeries?[key] = known }
                }
            }
            var result = try await client.catalog()
            guard context == libraryEpoch, self.source(source.id) != nil else { return }
            reconcileCloudMetadata(result.media)
            let previous = Dictionary(state.media.filter { $0.sourceID == source.id }.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            for index in result.media.indices {
                if let old = previous[result.media[index].id] { result.media[index].subtitlePath = old.subtitlePath; result.media[index].subtitleDelay = old.subtitleDelay }
            }
            // Keep lazy-loaded Xtream episodes when refreshing its parent series.
            let refreshedIDs = Set(result.media.map(\.id))
            let retained = state.media.filter { $0.sourceID == source.id && !refreshedIDs.contains($0.id) && ($0.kind == .episode && source.kind == .xtream || source.kind == .website) }
            state.media.removeAll { $0.sourceID == source.id }; state.media += result.media + retained
            state.programs.removeAll { $0.sourceID == source.id }; state.programs += result.programs
            if let index = state.sources.firstIndex(where: { $0.id == source.id }) {
                state.sources[index].refreshedAt = .now
                if let connection = result.websiteConnection {
                    state.sources[index].kind = .website; state.sources[index].websiteConnection = connection
                    if state.sources[index].name == SourceKind.direct.rawValue { state.sources[index].name = state.sources[index].host }
                }
            }
            state.websitePages = (state.websitePages ?? []).filter { $0.sourceID != source.id } + result.websitePages
            notices[source.id] = result.warning; save()
            await checkNewEpisodes(source, context: context)
        } catch { guard context == libraryEpoch else { return }; notices[source.id] = "Could not refresh \(source.name). Cached titles are still available. \(safeMessage(error))" }
    }
    private var refreshTask: Task<Void, Never>?
    func startRefresh() {
        #if DEBUG
        // This playback-only fixture intentionally has no matching server catalog.
        if ProcessInfo.processInfo.arguments.contains("--ui-test-episode-player") { return }
        #endif
        guard refreshTask == nil, playback == nil, !preparingPlayback else { return }
        refreshTask = Task { await refreshAll(); refreshTask = nil }
    }
    func refreshAll() async { for source in sources { await refresh(source) } }
    func removeSource(_ source: MediaSource) {
        account?.sourceChanged(source, deleted: true)
        do { try vault.remove(source.id.uuidString) } catch { self.error = safeMessage(error); return }
        state.sources.removeAll { $0.id == source.id }; state.media.removeAll { $0.sourceID == source.id }; state.programs.removeAll { $0.sourceID == source.id }
        state.websitePages?.removeAll { $0.sourceID == source.id }
        notices.removeValue(forKey: source.id); save()
    }
    func episodes(_ series: Media) -> [Media] { state.episodes(sourceID: series.sourceID, seriesID: series.providerID) }
    func loadEpisodes(_ series: Media) async {
        let context = libraryEpoch
        if series.websiteItem != nil {
            await loadWebsiteDetails(series)
            let current = media(series.id) ?? series
            if let first = current.websiteItem?.seasons.sorted(by: { $0.number < $1.number }).first(where: { $0.number > 0 }) ?? current.websiteItem?.seasons.first {
                await loadWebsiteSeason(current, number: first.number)
            }
            return
        }
        guard !preview, source(series.sourceID)?.kind == .xtream else { return }
        do { let fetched = try await api(series.sourceID).episodes(series); guard context == libraryEpoch else { return }; state.media.removeAll { $0.sourceID == series.sourceID && $0.seriesID == series.providerID && $0.kind == .episode }; state.media += fetched; save() }
        catch { self.error = safeMessage(error) }
    }
    func mergeMedia(_ items: [Media]) {
        mergeMedia(items, into: state)
    }
    private func mergeMedia(_ items: [Media], into state: LibraryState) {
        reconcileCloudMetadata(items, into: state)
        var media = state.media
        var indexes = Dictionary(media.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
        for var item in items {
            if let index = indexes[item.id] {
                let old = media[index]
                item.subtitlePath = old.subtitlePath; item.subtitleDelay = old.subtitleDelay
                if item.websiteItem?.seasons.isEmpty == true, let seasons = old.websiteItem?.seasons { item.websiteItem?.seasons = seasons }
                media[index] = item
            } else { indexes[item.id] = media.count; media.append(item) }
        }
        state.media = media
    }
    private func reconcileCloudMetadata(_ items: [Media]) {
        reconcileCloudMetadata(items, into: state)
    }
    private func reconcileCloudMetadata(_ items: [Media], into state: LibraryState) {
        let aliases = Dictionary(grouping: state.media.filter { $0.cloudIdentity != nil }, by: { $0.cloudIdentity! })
        guard !aliases.isEmpty else { return }
        var retired: Set<String> = []
        for item in items where item.cloudIdentity == nil {
            for old in aliases[item.cloudKey] ?? [] where old.id != item.id {
                if let progress = state.progress.removeValue(forKey: old.id), state.progress[item.id] == nil || state.progress[item.id]!.playedAt < progress.playedAt { state.progress[item.id] = progress }
                if state.favorites.remove(old.id) != nil { state.favorites.insert(item.id) }
                retired.insert(old.id)
            }
        }
        state.media.removeAll { retired.contains($0.id) }
    }
    func loadWebsiteDetails(_ item: Media) async {
        let context = libraryEpoch
        guard !preview, item.websiteItem != nil, !loadingWebsiteDetails.contains(item.id) else { return }
        loadingWebsiteDetails.insert(item.id); defer { loadingWebsiteDetails.remove(item.id) }
        do {
            let api = try api(item.sourceID)
            let client = WebsiteLibrary(source: api.source, endpoint: api.base)
            let connection = try await client.discover()
            let result = try await client.details(item, connection: connection)
            guard context == libraryEpoch else { return }
            mergeMedia([result.media] + result.episodes); save()
        } catch { self.error = safeMessage(error) }
    }
    func loadWebsiteSeason(_ series: Media, number: Int) async {
        let context = libraryEpoch
        guard !preview, series.websiteItem != nil, episodes(series).allSatisfy({ $0.season != number }) else { return }
        let key = "\(series.id):season:\(number)"
        guard !loadingWebsiteDetails.contains(key) else { return }
        loadingWebsiteDetails.insert(key); defer { loadingWebsiteDetails.remove(key) }
        do {
            let api = try api(series.sourceID); let client = WebsiteLibrary(source: api.source, endpoint: api.base)
            let connection = try await client.discover()
            let fetched = try await client.season(media(series.id) ?? series, number: number, connection: connection)
            guard context == libraryEpoch else { return }; mergeMedia(fetched); save()
        } catch { self.error = safeMessage(error) }
    }
    func loadWebsitePage(_ page: WebsiteCatalogPage) async {
        let context = libraryEpoch
        guard !preview, page.cursor != nil, !loadingWebsitePages.contains(page.id) else { return }
        loadingWebsitePages.insert(page.id); defer { loadingWebsitePages.remove(page.id) }
        do {
            let api = try api(page.sourceID); let client = WebsiteLibrary(source: api.source, endpoint: api.base)
            let connection = try await client.discover()
            let result = try await client.loadPage(page, connection: connection)
            guard context == libraryEpoch else { return }
            mergeMedia(result.media); state.programs += result.programs.filter { program in !state.programs.contains(where: { $0.id == program.id }) }
            if let index = state.websitePages?.firstIndex(where: { $0.id == page.id }) { state.websitePages?[index] = result.page }
            notices.removeValue(forKey: page.sourceID); save()
        } catch { notices[page.sourceID] = safeMessage(error) }
    }
    func searchWebsites(_ query: String) async throws -> [Media] {
        let context = libraryEpoch
        guard !preview, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        var matches: [Media] = [], failures = 0, successes = 0
        for source in sources where source.kind == .website {
            do {
                let api = try api(source.id); let client = WebsiteLibrary(source: source, endpoint: api.base)
                let connection = try await client.discover()
                matches += try await client.search(query, connection: connection); successes += 1
            } catch is CancellationError { throw CancellationError() }
            catch { failures += 1 }
        }
        try Task.checkCancellation()
        if successes == 0 && failures > 0 { throw OxaError.message("Website search could not be loaded. Cached titles are still searchable.") }
        guard context == libraryEpoch else { throw CancellationError() }
        mergeMedia(matches); save()
        return matches
    }
    func localURL(_ item: Media) -> URL? {
        guard let disk, let transfer = state.transfers.first(where: { $0.id == item.id && $0.state == .ready }) else { return nil }
        let url: URL?
        if let path = transfer.systemRelativePath, path.hasPrefix("Library/") { url = URLPolicy.relativeFile(path, root: URL(fileURLWithPath: NSHomeDirectory())) }
        else if let path = transfer.relativePath { url = URLPolicy.relativeFile(path, root: disk.mediaRoot) }
        else { url = nil }
        guard let url, FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }
    func requestSources(_ item: Media, download: Bool = false) async throws {
        let context = libraryEpoch
        let api = try api(item.sourceID)
        let client = WebsiteLibrary(source: api.source, endpoint: api.base)
        let (detailed, choices) = try await client.sources(item, connection: client.discover())
        try Task.checkCancellation()
        guard context == libraryEpoch else { throw CancellationError() }
        sourceSelection = SourceSelection(media: detailed, choices: choices, download: download)
    }
    func selectSource(_ selection: SourceSelection, choice: WebsiteStream) async throws {
        let context = libraryEpoch
        let api = try api(selection.media.sourceID)
        let client = WebsiteLibrary(source: api.source, endpoint: api.base)
        let prepared = try await client.playable(selection.media, connection: client.discover(), subtitleLanguage: state.preferences.subtitleLanguage, selected: choice)
        try Task.checkCancellation()
        guard context == libraryEpoch else { throw CancellationError() }
        if selection.download {
            let batch = selection.batch.isEmpty ? [prepared] : selection.batch
            downloads.enqueueBatch(batch.map { item in var item = item; item.downloadPreference = choice; item.websiteResolved = selection.batch.isEmpty; return item })
            return
        }
        guard let url = prepared.stream else { throw OxaError.message("No playable stream was returned.") }
        var next = Playback(selectedSource: choice, media: prepared, url: url)
        if let active = playback { next.id = active.id }
        if playback == nil { pendingPlayback = next } else { playback = next }
        sourceSelection = nil
    }
    func presentPendingPlayback() { if let next = pendingPlayback { pendingPlayback = nil; playback = next } }
    func retryPlayback(_ active: Playback) async throws -> Playback {
        let context = libraryEpoch
        if active.url.isFileURL { return active }
        if let choice = active.selectedSource {
            let api = try api(active.media.sourceID)
            let client = WebsiteLibrary(source: api.source, endpoint: api.base)
            let connection = try await client.discover()
            let (detailed, choices) = try await client.sources(active.media, connection: connection)
            guard let freshChoice = choices.first(where: { $0.name == choice.name && $0.languages == choice.languages && $0.quality == choice.quality && $0.url.host == choice.url.host }) else { throw OxaError.message("This server is no longer listed. Choose another source.") }
            let prepared = try await client.playable(detailed, connection: connection, subtitleLanguage: state.preferences.subtitleLanguage, selected: freshChoice)
            guard context == libraryEpoch else { throw CancellationError() }
            guard let url = prepared.stream else { throw OxaError.message("No playable stream was returned.") }
            return Playback(id: active.id, selectedSource: freshChoice, media: prepared, url: url)
        }
        let api = try api(active.media.sourceID)
        let prepared = try await api.preparePlayback(active.media, subtitleLanguage: state.preferences.subtitleLanguage)
        let url = try await api.playbackURL(prepared)
        guard context == libraryEpoch else { throw CancellationError() }
        return Playback(id: active.id, media: prepared, url: url)
    }
    func downloadSeason(_ episodes: [Media]) {
        guard let first = episodes.first else { return }
        if first.websiteItem == nil { downloads.enqueueBatch(episodes); return }
        Task {
            do { try await requestSources(first, download: true); sourceSelection?.batch = episodes }
            catch { self.error = safeMessage(error) }
        }
    }
    func download(_ item: Media) {
        guard item.websiteItem != nil else { downloads.enqueue(item); return }
        Task { do { try await requestSources(item, download: true) } catch { self.error = safeMessage(error) } }
    }
    func play(_ item: Media) async {
        let context = libraryEpoch
        guard !preview else { error = "Preview titles illustrate the layout. Add your own source to play your films."; return }
        guard !preparingPlayback else { return }
        preparingPlayback = true; defer { preparingPlayback = false }
        do {
            let url: URL
            var prepared = item
            if let local = localURL(item) {
                url = local
                if let saved = state.transfers.first(where: { $0.id == item.id && $0.state == .ready }) { prepared = saved.media }
            }
            else {
                if item.websiteItem != nil { try await requestSources(item); return }
                let client = try api(item.sourceID)
                prepared = try await client.preparePlayback(item, subtitleLanguage: state.preferences.subtitleLanguage)
                url = try await client.playbackURL(prepared)
            }
            guard context == libraryEpoch else { return }
            playback = Playback(media: prepared, url: url)
        } catch { if context == libraryEpoch { self.error = safeMessage(error) } }
    }
    func record(_ item: Media, seconds: Double, duration: Double, ended: Bool = false) {
        guard !preview, item.kind != .channel, seconds.isFinite else { return }
        if item.kind == .episode, let seriesID = item.seriesID {
            if state.followedSeries == nil { state.followedSeries = [:] }
            let key = "\(item.sourceID):\(seriesID)"
            if state.followedSeries?[key] == nil { let known = Set(catalog.filter { $0.sourceID == item.sourceID && $0.seriesID == seriesID && $0.kind == .episode }.map(\.id)); state.followedSeries?[key] = known }
            state.newEpisodeIDs?.remove(item.id)
        }
        let total = duration.isFinite && duration > 0 ? duration : item.duration
        // Match desktop and web: the last 30 seconds (or 3 %) count as watched.
        let finished = ended || (total > 0 && seconds >= total - min(30, total * 0.03))
        state.progress[item.id] = WatchProgress(seconds: seconds, duration: total, completed: finished)
        save(); account?.progressChanged(item)
    }
    func nextEpisode(_ item: Media) -> Media? {
        guard item.kind == .episode, let seriesID = item.seriesID else { return nil }
        let episodes = state.episodes(sourceID: item.sourceID, seriesID: seriesID)
        guard let index = episodes.firstIndex(where: { $0.id == item.id }), index + 1 < episodes.count else { return nil }; return episodes[index + 1]
    }
    func toggleFavorite(_ item: Media) { if state.favorites.contains(item.id) { state.favorites.remove(item.id) } else { state.favorites.insert(item.id) }; save(); account?.watchlistChanged(item, present: state.favorites.contains(item.id)) }
    func guide(_ item: Media) -> [TVProgram] {
        guard let channel = item.channelID else { return [] }
        return state.guide(sourceID: item.sourceID, channelID: channel, after: .now)
    }
    func safeMessage(_ error: Error) -> String {
        if error is OxaError { return error.localizedDescription }
        if let error = error as? URLError {
            switch error.code { case .notConnectedToInternet: return "You’re offline. Play a saved download or try again when connected."
            case .timedOut: return "The server took too long to respond. Try again."
            case .serverCertificateUntrusted, .serverCertificateHasBadDate, .secureConnectionFailed: return "The server’s HTTPS certificate could not be verified. Check its certificate."
            case .cancelled: return "The request was cancelled."
            default: return "Could not connect to the source. Check its address, network access and credentials." }
        }
        return "This operation could not be completed. Check the source and available storage, then try again."
    }
    func activateAccount(_ identity: AccountIdentity, mergeGuest: Bool) async throws {
        guard accountID != identity.id else { return }
        guard let disk else { throw OxaError.message("Local storage is unavailable.") }
        let context = libraryEpoch
        try await persistSnapshot()
        guard context == libraryEpoch else { throw CancellationError() }
        let guest = accountID == nil && mergeGuest ? state.snapshot : LibrarySnapshot()
        let credentials = Dictionary(uniqueKeysWithValues: guest.sources.compactMap { source -> (UUID, Credentials)? in
            guard let secret = try? vault.credentials(source.id) else { return nil }; return (source.id, secret)
        })
        let restored = try await persistence.read { try disk.loadNamed("library-\(identity.id)", as: LibrarySnapshot.self) ?? LibrarySnapshot() }
        guard context == libraryEpoch else { throw CancellationError() }
        let staged = LibraryState(restored), destinationVault = Vault()
        destinationVault.namespace = identity.id.uuidString + ":"
        for source in guest.sources where !staged.sources.contains(where: { $0.id == source.id }) {
            if let secret = credentials[source.id] { try destinationVault.save(secret, id: source.id); staged.sources.append(source) }
        }
        mergeMedia(guest.media, into: staged)
        staged.progress.merge(guest.progress) { current, incoming in current.playedAt > incoming.playedAt ? current : incoming }
        staged.favorites.formUnion(guest.favorites)
        staged.transfers += guest.transfers.filter { transfer in !staged.transfers.contains(where: { $0.id == transfer.id }) }
        let snapshot = staged.snapshot, name = "library-\(identity.id)"
        try await persistence.flush(key: name) { try disk.saveNamed(snapshot, name: name) }
        guard context == libraryEpoch else { throw CancellationError() }
        // The destination and marker must be durable before changing the live
        // scope. Any failure above leaves the old account/guest view untouched.
        try identityVault.write(JSONEncoder().encode(identity), key: "active-account")
        commitLibrary(snapshot, owner: identity.id)
        if mergeGuest && !guest.transfers.isEmpty {
            var remainingGuest = guest; remainingGuest.transfers = []
            // Failure to retire duplicate guest references must never turn an
            // already committed account switch into a half-failed sign-in.
            try? await persistence.flush(key: "library") { try disk.save(remainingGuest) }
        }
    }
    func activateGuest() async throws {
        guard let disk else { throw OxaError.message("Local storage is unavailable.") }
        let context = libraryEpoch
        try await persistSnapshot()
        let guest = try await persistence.read { try disk.load() }
        guard context == libraryEpoch else { throw CancellationError() }
        try identityVault.remove("active-account")
        commitLibrary(guest, owner: nil)
    }
    private func commitLibrary(_ snapshot: LibrarySnapshot, owner: UUID?) {
        libraryEpoch = UUID(); playback = nil; pendingPlayback = nil; sourceSelection = nil; notices = [:]
        accountID = owner; vault.namespace = owner.map { $0.uuidString + ":" } ?? ""; state = LibraryState(snapshot)
    }
    func enablePreview() {
        preview = true
        let id = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        state = LibraryState(); state.sources = [MediaSource(id: id, name: "Preview library", kind: .jellyfin, host: "Preview — no connection")]
        let series = Media(id: "preview-series", sourceID: id, providerID: "series", title: "The Quiet Coast", kind: .series, overview: "A journey along the edges of the Atlantic, where the sea sets the pace.", year: 2026)
        var episode = Media(id: "preview-episode", sourceID: id, providerID: "episode", title: "Where the land ends", kind: .episode, overview: "The fishing villages and open horizons of the western coast.", duration: 2820)
        episode.seriesID = "series"; episode.seriesTitle = series.title; episode.season = 1; episode.episode = 3
        state.media = [series, episode,
                       Media(id: "preview-film1", sourceID: id, providerID: "film1", title: "After the Rain", kind: .movie, overview: "A portrait of a city finding its rhythm again.", year: 2025, duration: 6180),
                       Media(id: "preview-film2", sourceID: id, providerID: "film2", title: "A Place Apart", kind: .movie, overview: "A quiet weekend in the mountains becomes a new beginning.", year: 2024, duration: 5460),
                       Media(id: "preview-film3", sourceID: id, providerID: "film3", title: "Northern Light", kind: .movie, overview: "Under a winter sky, two strangers follow the same road.", year: 2026, duration: 5700)]
        state.progress[episode.id] = WatchProgress(seconds: 1094, duration: 2820)
    }
    /// Looks for a newer release at most every six hours unless the person asks.
    /// Returns false when GitHub could not be reached.
    @discardableResult func checkForUpdate(manual: Bool = false) async -> Bool {
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--ui-test") }) { return true }
        if !manual, let at = updateCheckedAt, Date().timeIntervalSince(at) < 6 * 3600 { return true }
        updateCheckedAt = Date()
        let release: AppRelease?
        do { release = try await UpdateCheck.latest() } catch { return false }
        if manual { UserDefaults.standard.removeObject(forKey: "skipped-update") }
        availableUpdate = release?.version == UserDefaults.standard.string(forKey: "skipped-update") ? nil : release
        return true
    }
    func skipUpdate() { UserDefaults.standard.set(availableUpdate?.version, forKey: "skipped-update"); availableUpdate = nil }
    func leavePreview() {
        preview = false
        // Return to the library that owns this scope; the guest file is not the account's.
        do {
            if let owner = accountID { state = LibraryState(try disk?.loadNamed("library-\(owner)", as: LibrarySnapshot.self) ?? LibrarySnapshot()) }
            else { state = LibraryState(try disk?.load() ?? LibrarySnapshot()) }
        } catch { storageAvailable = false; self.error = "The saved library could not be opened. Existing data was preserved." }
    }
    #if DEBUG
    private func enablePerformanceFixture() {
        preview = true
        let sourceID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        var fixture = LibrarySnapshot()
        fixture.sources = [MediaSource(id: sourceID, name: "Performance fixture", kind: .jellyfin, host: "fixture.invalid")]
        fixture.media = (0..<10_000).map { Media(id: "performance-film-\($0)", sourceID: sourceID, providerID: "film-\($0)", title: "Fixture Film \($0)", kind: .movie) }
        for number in 0..<100 {
            let series = Media(id: "performance-series-\(number)", sourceID: sourceID, providerID: "series-\(number)", title: "Fixture Series \(number)", kind: .series)
            fixture.media.append(series)
            for episode in 1...100 {
                var item = Media(id: "performance-episode-\(number)-\(episode)", sourceID: sourceID, providerID: "episode-\(number)-\(episode)", title: "Episode \(episode)", kind: .episode)
                item.seriesID = series.providerID; item.seriesTitle = series.title; item.season = 1; item.episode = episode
                fixture.media.append(item)
            }
        }
        for number in 0..<400 {
            var channel = Media(id: "performance-channel-\(number)", sourceID: sourceID, providerID: "channel-\(number)", title: "Fixture Channel \(number)", kind: .channel)
            channel.channelID = channel.providerID; channel.group = "Group \(number % 10)"; fixture.media.append(channel)
            for slot in 0..<50 {
                fixture.programs.append(TVProgram(id: "performance-program-\(number)-\(slot)", sourceID: sourceID, channelID: channel.providerID, title: "Program \(slot)", start: Date().addingTimeInterval(Double(slot - 1) * 3600), end: Date().addingTimeInterval(Double(slot) * 3600), overview: "Local performance fixture"))
            }
        }
        fixture.transfers = [Transfer(id: fixture.media[0].id, media: fixture.media[0], state: .downloading)]
        state = LibraryState(fixture)
        Task { [weak self] in
            for tick in 0..<480 {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, self.preview, self.state.transfers.count == 1 else { return }
                self.state.transfers[0].fraction = Double(tick % 100) / 100
                self.state.transfers[0].bytes = Int64(tick) * 100_000
            }
        }
    }
    #endif
}
