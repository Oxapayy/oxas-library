import SwiftUI

enum LibrarySort: String, CaseIterable, Identifiable {
    case standard = "Default", recent = "Recently Watched", title = "A–Z", newest = "Year (newest)", oldest = "Year (oldest)"
    var id: String { rawValue }
}

struct LibraryView: View {
    @Environment(AppStore.self) private var store
    @Environment(ShelfModel.self) private var shelves
    @Namespace private var zoom
    @State private var selectedSource: UUID?
    @State private var type = "All"
    @State private var sort = LibrarySort.standard
    /// Sorted grid, computed once per sort/filter/catalog change instead of on every body pass.
    @State private var sortedGrid: (key: String, items: [Media])?
    @State private var importing = false
    @ScaledMetric(relativeTo: .largeTitle) private var welcomeSize = 32
    private var visible: [Media] {
        store.catalog.filter { item in
            guard [.movie, .series].contains(item.kind), selectedSource == nil || item.sourceID == selectedSource else { return false }
            switch type {
            case "Movies": return item.kind == .movie
            case "Series": return item.kind == .series
            case "Watchlist": return store.state.favorites.contains(item.id)
            default: return true
            }
        }
    }
    var body: some View {
        GeometryReader { geometry in
            let top = geometry.safeAreaInsets.top
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    if store.sources.isEmpty { firstRun(top: top) } else { library(top: top, width: geometry.size.width) }
                }.padding(.bottom, 28)
            }.ignoresSafeArea(edges: .top)
        }.background(OxaTheme.ground).toolbar(.hidden, for: .navigationBar).refreshable { store.startRefresh(force: true) }
            .task(id: sortKey) {
                guard sort != .standard, type != "All" else { sortedGrid = nil; return }
                sortedGrid = (sortKey, sorted(visible))
            }
    }

    @ViewBuilder private func library(top: CGFloat, width: CGFloat) -> some View {
        let visible = visible
        let inSource = { (item: Media) in selectedSource == nil || item.sourceID == selectedSource }
        let newEpisodes = store.newEpisodes.filter(inSource)
        let continueWatching = store.continueWatching.filter(inSource)
        let derived = shelves.shelves
        let resolve = { (ids: [String]) in ids.compactMap { store.media($0) }.filter(inSource) }
        let picks = type == "All" ? resolve(derived.picks) : []
        let slides = heroSlides(visible: visible, continueWatching: continueWatching, newEpisodes: newEpisodes, picks: picks)
        if slides.isEmpty { libraryBar.padding(.top, top + 6) }
        else { HeroStage(slides: slides, height: min(720, max(480, width * 1.22)) + top, topInset: top) { libraryBar }.padding(.bottom, -8) }
        if store.sources.count > 1 {
            Menu { Button("All sources") { selectedSource = nil }; ForEach(store.sources) { source in Button(source.name) { selectedSource = source.id } } } label: {
                Label(selectedSource.flatMap { store.source($0)?.name } ?? "All sources", systemImage: "line.3.horizontal.decrease").font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(1).frame(minHeight: 44)
            }.accessibilityLabel("Filter by source").padding(.horizontal, 20).padding(.vertical, -12)
        }
        if !store.refreshing.isEmpty { Label("Refreshing sources… You can keep browsing.", systemImage: "arrow.trianglehead.2.clockwise.rotate.90").font(.caption).foregroundStyle(OxaTheme.secondary).padding(.horizontal, 20) }
        if let update = store.availableUpdate { UpdateBanner(release: update).padding(.horizontal, 20) }
        if store.preview {
            HStack { Text("Preview library · illustrative titles").font(.caption).foregroundStyle(OxaTheme.secondary); Spacer(); Button("Exit Preview") { store.leavePreview() }.font(.caption.weight(.semibold)).frame(minHeight: 44) }.padding(.horizontal, 20)
        }
        if type == "All" {
            let moreWatching = Array(continueWatching.dropFirst())
            if !moreWatching.isEmpty {
                ShelfRow(title: "Also watching") { ForEach(moreWatching) { item in ResumeCard(media: item).frame(width: 260) } }
            }
            if !newEpisodes.isEmpty {
                ShelfRow(title: "New Episodes") { ForEach(newEpisodes) { item in ResumeCard(media: item, style: .newEpisode).frame(width: 260) } }
            }
            if !picks.isEmpty { posterRow("Picks for You", picks, shelf: "picks", note: "Based on titles you watched or saved", identified: false) }
            ForEach(derived.because) { row in
                let items = resolve(row.items)
                if items.count >= 5 { posterRow("Because You Watched \(row.seedTitle)", items, shelf: "because-\(row.seedID)", identified: false) }
            }
            let again = resolve(derived.watchAgain)
            if !again.isEmpty { posterRow("Watch Again", again, shelf: "again", identified: false) }
            ReadyOffline(sourceID: selectedSource)
            let watchlist = visible.filter { store.state.favorites.contains($0.id) }
            if !watchlist.isEmpty { posterRow("Watchlist", watchlist, shelf: "watchlist") }
            let movies = visible.filter { $0.kind == .movie }, series = visible.filter { $0.kind == .series }
            if !movies.isEmpty { posterRow("Movies", movies, shelf: "movies") }
            if !series.isEmpty { posterRow("Series", series, shelf: "series") }
        } else if !visible.isEmpty {
            SectionHeading(title: type, count: visible.count) {
                Menu {
                    Picker("Sort", selection: $sort) { ForEach(LibrarySort.allCases) { Text($0.rawValue).tag($0) } }
                } label: { Label("Sort", systemImage: "arrow.up.arrow.down").font(.subheadline).frame(minHeight: 44) }.accessibilityLabel("Sort, \(sort.rawValue)")
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), alignment: .leading, spacing: 20) {
                ForEach(sort == .standard || sortedGrid?.key != sortKey ? visible : sortedGrid?.items ?? visible) { item in posterLink(item, shelf: "grid") }
            }.padding(.horizontal, 16)
        }
        if visible.isEmpty {
            EmptyPanel(title: type == "Watchlist" ? "Your watchlist is empty" : "No titles here yet", message: type == "Watchlist" ? "Tap + on a film or series to keep it here." : "Add a movie or series source, or choose another filter. Your live channels are in Live TV.", icon: type == "Watchlist" ? "plus.circle" : "film").padding(.horizontal, 16)
        }
        ForEach((store.state.websitePages ?? []).filter { $0.cursor != nil && $0.catalog.type != "live" && (selectedSource == nil || $0.sourceID == selectedSource) && (type == "All" || type == "Watchlist" || type == "Movies" && $0.catalog.type == "video" || type == "Series" && $0.catalog.type == "series") }) { page in
            Button { Task { await store.loadWebsitePage(page) } } label: {
                HStack { if store.loadingWebsitePages.contains(page.id) { ProgressView() }; Label("Load More · \(page.catalog.name)", systemImage: "arrow.down"); Spacer(); Text(store.source(page.sourceID)?.name ?? "").foregroundStyle(OxaTheme.secondary).font(.caption) }.padding(16).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }.disabled(store.loadingWebsitePages.contains(page.id)).accessibilityIdentifier("load-more-\(page.addonID)-\(page.catalog.id)").padding(.horizontal, 16)
        }
        ForEach(store.sources.filter { store.notices[$0.id] != nil }) { source in
            VStack(alignment: .leading, spacing: 10) {
                Text(store.notices[source.id] ?? "").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                Button("Retry \(source.name)") { Task { await store.refresh(source) } }.disabled(store.refreshing.contains(source.id))
            }.padding(20).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 16)).padding(.horizontal, 16)
        }
    }

    private var libraryBar: some View {
        HStack(spacing: 8) {
            CategoryBar(selection: $type) { store.selectedTab = 2 }
            Button { store.showAddSource = true } label: { Image(systemName: "plus").font(.body.weight(.semibold)).frame(width: 48, height: 48).glassPill(Circle()) }.buttonStyle(PressStyle()).accessibilityLabel("Add source")
        }.padding(.horizontal, 16)
    }

    /// Hero candidates in order: what you are watching, a new episode, two picks,
    /// otherwise the first catalog title. Filtered views show their first title.
    private func heroSlides(visible: [Media], continueWatching: [Media], newEpisodes: [Media], picks: [Media]) -> [HeroSlide] {
        guard type == "All" else { return visible.first.map { [HeroSlide(media: $0)] } ?? [] }
        var slides: [HeroSlide] = [], seen: Set<String> = []
        func add(_ item: Media?, _ kicker: String?) { if let item, seen.insert(item.id).inserted { slides.append(HeroSlide(media: item, kicker: kicker)) } }
        add(continueWatching.first, "Continue Watching")
        add(newEpisodes.first, "New Episode")
        for item in picks.prefix(2) { add(item, "Picked for You") }
        if slides.isEmpty { add(visible.first, nil) }
        return slides
    }

    private var sortKey: String {
        "\(type)|\(sort.rawValue)|\(selectedSource?.uuidString ?? "")|\(store.state.catalogRevision)|\(store.libraryEpoch)|\(type == "Watchlist" ? store.state.favorites.count : 0)|\(sort == .recent ? store.state.progress.count : 0)"
    }
    private func sorted(_ items: [Media]) -> [Media] {
        switch sort {
        case .standard: return items
        case .title: return items.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        case .newest, .oldest:
            let newest = sort == .newest
            return items.enumerated().sorted { a, b in
                let x = a.element.year ?? (newest ? .min : .max), y = b.element.year ?? (newest ? .min : .max)
                return x != y ? (newest ? x > y : x < y) : a.offset < b.offset
            }.map(\.element)
        case .recent:
            var latest: [String: Date] = [:]
            for (id, progress) in store.state.progress where progress.seconds > 0 || progress.completed {
                guard let item = store.media(id) else { continue }
                let key = "\(item.sourceID):\(item.kind == .episode ? item.seriesID ?? item.providerID : item.providerID)"
                latest[key] = max(latest[key] ?? .distantPast, progress.playedAt)
            }
            return items.enumerated().sorted { a, b in
                let x = latest["\(a.element.sourceID):\(a.element.providerID)"] ?? .distantPast, y = latest["\(b.element.sourceID):\(b.element.providerID)"] ?? .distantPast
                return x != y ? x > y : a.offset < b.offset
            }.map(\.element)
        }
    }

    private func posterRow(_ title: String, _ items: [Media], shelf: String, note: String? = nil, identified: Bool = true) -> some View {
        ShelfRow(title: title, count: identified ? items.count : nil, note: note) { ForEach(items) { item in posterLink(item, shelf: shelf, identified: identified).frame(width: 140) } }
    }
    /// Only the catalog rows carry the `media-card-*` identifier, so a title that
    /// also appears in a derived shelf stays unique for UI tests.
    private func posterLink(_ item: Media, shelf: String, identified: Bool = true) -> some View {
        let key = "\(shelf):\(item.id)"
        return NavigationLink { MediaDetailView(media: item).navigationTransition(.zoom(sourceID: key, in: zoom)) } label: {
            PosterCard(media: item).matchedTransitionSource(id: key, in: zoom)
        }.buttonStyle(PressStyle()).contextMenu { MediaActions(media: item) }
            .accessibilityIdentifier(identified ? "media-card-\(item.providerID)" : "\(shelf)-card-\(item.providerID)")
    }

    private func firstRun(top: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 28) {
            ZStack(alignment: .topLeading) {
                Color.clear.frame(height: 330 + top).frame(maxWidth: .infinity).overlay { PosterWall() }.clipped()
                HStack(spacing: 10) { OxaMark(size: 25); Text("Oxa’s Library").font(.headline) }.frame(minHeight: 44).padding(.horizontal, 20).padding(.top, top + 4)
            }
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("A home for\nyour collection.").font(.system(size: welcomeSize, weight: .bold)).tracking(-0.8).fixedSize(horizontal: false, vertical: true)
                    Text("Your films, series and live TV.\nConnected to the sources you choose.").font(.body).foregroundStyle(OxaTheme.secondary).lineSpacing(4)
                }
                PrimaryAction(title: importing ? "Importing…" : "Import huhu.to", icon: "plus") {
                    importing = true
                    Task { defer { importing = false }; do { try await store.addSource(name: "huhu.to", kind: .website, credentials: Credentials(endpoint: "https://huhu.to"), allowHTTP: false) } catch { store.error = store.safeMessage(error) } }
                }.disabled(importing)
                Button("Connect Your Own Server") { store.showAddSource = true }.font(.subheadline.weight(.medium)).frame(maxWidth: .infinity, minHeight: 44)
                VStack(alignment: .leading, spacing: 24) {
                    sourceRow("Your libraries", subtitle: "Website catalogs, Plex, Jellyfin and Emby", icon: "server.rack")
                    sourceRow("Your own files", subtitle: "NAS via WebDAV and video URLs", icon: "externaldrive")
                    sourceRow("Your live channels", subtitle: "M3U playlists and Xtream Codes", icon: "tv")
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: OxaTheme.radiusPanel))
                HStack(alignment: .top, spacing: 10) { Image(systemName: "lock"); Text("Your watch history stays on this iPhone.\nNo Oxa account needed.").fixedSize(horizontal: false, vertical: true) }.font(.subheadline).foregroundStyle(OxaTheme.secondary)
                Button("Explore a Preview Library") { store.enablePreview() }.font(.subheadline.weight(.medium)).frame(maxWidth: .infinity, minHeight: 44)
            }.padding(.horizontal, 20).padding(.top, -96)
        }
    }
    private func sourceRow(_ title: String, subtitle: String, icon: String) -> some View {
        HStack(alignment: .top, spacing: 16) { Image(systemName: icon).font(.title3).foregroundStyle(OxaTheme.secondary).frame(width: 24); VStack(alignment: .leading, spacing: 5) { Text(title).font(.body.weight(.medium)); Text(subtitle).font(.subheadline).foregroundStyle(OxaTheme.secondary) } }
    }
}

/// Its own view, so download progress ticks re-render this shelf only, not the library.
private struct ReadyOffline: View {
    @Environment(AppStore.self) private var store
    let sourceID: UUID?
    var body: some View {
        let offline = Shelves.readyOffline(store.state.transfers).filter { sourceID == nil || $0.sourceID == sourceID }
        if !offline.isEmpty {
            ShelfRow(title: "Ready Offline", count: offline.count) { ForEach(offline) { item in ResumeCard(media: item, style: .offline).frame(width: 260) } }
        }
    }
}

/// Tilted wall of the app's own preview artwork behind the first-run welcome.
private struct PosterWall: View {
    @Environment(\.colorSchemeContrast) private var contrast
    private let names = ["preview-film1", "preview-series", "preview-film2", "preview-film3"]
    var body: some View {
        ZStack {
            // Drawn as an overlay so the oversized wall never sets this view's size.
            Color.clear.overlay { HStack(alignment: .top, spacing: 12) {
                ForEach(0..<5, id: \.self) { column in
                    VStack(spacing: 12) {
                        ForEach(0..<4, id: \.self) { row in
                            Image(names[(column + row * 3) % names.count]).resizable().scaledToFill().frame(width: 112, height: 168)
                                .clipShape(RoundedRectangle(cornerRadius: OxaTheme.radiusCard))
                        }
                    }.offset(y: column.isMultiple(of: 2) ? -70 : -10)
                }
            }.rotationEffect(.degrees(-12)).opacity(0.72) }
            VStack(spacing: 0) { OxaTheme.topScrim(contrast).frame(height: 140); Spacer() }
            OxaTheme.bottomScrim(contrast)
        }.clipped().accessibilityHidden(true)
    }
}

/// The context actions every card offers. They only call existing actions.
struct MediaActions: View {
    @Environment(AppStore.self) private var store
    let media: Media
    var body: some View {
        let listed = media.kind == .episode ? store.catalog.first { $0.kind == .series && $0.sourceID == media.sourceID && $0.providerID == media.seriesID } ?? media : media
        let saved = store.state.favorites.contains(listed.id)
        if media.kind != .series {
            let progress = store.state.progress[media.id]
            let resuming = progress.map { !$0.completed && $0.seconds > 0 } ?? false
            Button { Task { await store.play(media) } } label: { Label(resuming ? "Resume" : "Play", systemImage: "play.fill") }
        }
        Button { store.toggleFavorite(listed) } label: { Label(saved ? "Remove from Watchlist" : "Add to Watchlist", systemImage: saved ? "checkmark" : "plus") }
        if media.kind == .movie || media.kind == .episode, !store.preview, store.state.transfers.first(where: { $0.id == media.id }) == nil {
            Button { store.download(media) } label: { Label("Download", systemImage: "arrow.down.to.line") }
        }
    }
}

/// Thin progress line under or across artwork.
struct ProgressLine: View {
    let fraction: Double
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.24))
                Capsule().fill(OxaTheme.accent).frame(width: geometry.size.width * min(max(fraction, 0), 1))
            }
        }.frame(height: 3).accessibilityHidden(true)
    }
}

struct ResumeCard: View {
    enum Style { case resume, newEpisode, offline }
    @Environment(AppStore.self) private var store
    @Environment(\.colorSchemeContrast) private var contrast
    let media: Media
    var style = Style.resume
    var body: some View {
        let progress = store.state.progress[media.id]
        let started = progress.map { !$0.completed && $0.seconds > 0 } ?? false
        Button { Task { await store.play(media) } } label: {
            VStack(alignment: .leading, spacing: 10) {
                ZStack(alignment: .bottomLeading) {
                    ArtView(media: media, wide: true)
                    Image(systemName: "play.fill").font(.footnote).foregroundStyle(.black).frame(width: 34, height: 34).background(OxaTheme.onWhite, in: Circle()).padding(10).padding(.bottom, started ? 6 : 0)
                    if started, let progress { ProgressLine(fraction: progress.fraction).padding(.horizontal, 10).padding(.bottom, 8) }
                }.aspectRatio(16 / 9, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: OxaTheme.radiusCard)).overlay(RoundedRectangle(cornerRadius: OxaTheme.radiusCard).stroke(OxaTheme.hairline(contrast)))
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(media.displayTitle).font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
                        Spacer(minLength: 0)
                        if store.localURL(media) != nil { Image(systemName: "arrow.down.circle.fill").font(.footnote).foregroundStyle(OxaTheme.secondary).accessibilityHidden(true) }
                    }
                    Text(caption(progress)).font(.caption).foregroundStyle(OxaTheme.secondary).monospacedDigit().lineLimit(1)
                }
            }
        }.buttonStyle(PressStyle()).contextMenu { MediaActions(media: media) }.accessibilityLabel(label(progress, started: started))
    }
    private func caption(_ progress: WatchProgress?) -> String {
        let episode = media.kind == .episode ? "\(media.episodeLabel) · \(media.title)" : nil
        switch style {
        case .newEpisode: return ["New episode", episode].compactMap { $0 }.joined(separator: " · ")
        case .offline: return episode ?? "Downloaded"
        case .resume:
            let left = "\(max(0, (progress?.duration ?? 0) - (progress?.seconds ?? 0)).clock) left"
            return [episode, left].compactMap { $0 }.joined(separator: " · ")
        }
    }
    private func label(_ progress: WatchProgress?, started: Bool) -> String {
        switch style {
        case .resume: return "Resume \(media.displayTitle) at \(progress?.seconds.clock ?? "0:00")"
        case .newEpisode: return "Play \(media.displayTitle), new episode \(media.episodeLabel)"
        case .offline: return started ? "Resume \(media.displayTitle) offline at \(progress?.seconds.clock ?? "0:00")" : "Play \(media.displayTitle) offline"
        }
    }
}
struct PosterCard: View {
    @Environment(\.colorSchemeContrast) private var contrast
    var media: Media
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ArtView(media: media).aspectRatio(2 / 3, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: OxaTheme.radiusCard)).overlay(RoundedRectangle(cornerRadius: OxaTheme.radiusCard).stroke(OxaTheme.hairline(contrast)))
            VStack(alignment: .leading, spacing: 2) {
                Text(media.title).font(.footnote.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
                Text([media.year.map(String.init), media.kind == .series ? "Series" : "Film"].compactMap { $0 }.joined(separator: " · ")).font(.caption2).foregroundStyle(OxaTheme.secondary).lineLimit(1)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
    }
}
struct SearchView: View {
    @Environment(AppStore.self) private var store
    @Environment(ShelfModel.self) private var shelves
    @State private var query = ""
    @State private var remoteBusy = false
    @State private var remoteMessage: String?
    @State private var searchRetry = 0
    @State private var results: [Media] = []
    @State private var channels: [Media] = []
    @State private var localBusy = false
    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if remoteBusy { ProgressView("Searching connected libraries…").padding(20).frame(maxWidth: .infinity) }
                if let remoteMessage { VStack(spacing: 8) { Text(remoteMessage).font(.subheadline).foregroundStyle(OxaTheme.secondary); Button("Retry") { searchRetry += 1 } }.padding(20).frame(maxWidth: .infinity) }
                if localBusy && results.isEmpty && channels.isEmpty { ProgressView("Searching your library…").padding(20).frame(maxWidth: .infinity) }
                else if !searching { suggestions }
                else if results.isEmpty && channels.isEmpty { EmptyPanel(title: "No matching titles", message: "Try a different title or refresh your media sources.", icon: "magnifyingglass").padding(.horizontal, 20) }
                else {
                    let movies = results.filter { $0.kind == .movie }, series = results.filter { $0.kind == .series }
                    if !movies.isEmpty { group("Movies", movies) }
                    if !series.isEmpty { group("Series", series) }
                    if !channels.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            SectionHeading(title: "Channels", count: channels.count)
                            LazyVStack(spacing: 14) {
                                ForEach(channels) { channel in
                                    Button { Task { await store.play(channel) } } label: { MediaRow(media: channel, trailing: "play.fill") }.buttonStyle(PressStyle())
                                        .accessibilityIdentifier("search-channel-\(channel.providerID)").accessibilityHint("Plays this channel")
                                }
                            }.padding(.horizontal, 20)
                        }
                    }
                }
            }.padding(.vertical, 16)
        }.background(OxaTheme.ground).navigationTitle("Search").navigationBarTitleDisplayMode(.inline).searchable(text: $query, prompt: "Films and series")
            .onChange(of: store.libraryEpoch) { results = []; channels = [] }
            .onChange(of: searching) { results = []; channels = [] }
            .task(id: LocalSearchKey(query: query, revision: store.state.catalogRevision, epoch: store.libraryEpoch)) {
                localBusy = true
                do {
                    if !query.isEmpty { try await Task.sleep(for: .milliseconds(120)) }
                    let catalog = store.catalog, text = query
                    let work = Task.detached(priority: .userInitiated) { () throws -> ([Media], [Media]) in
                        let found = try CatalogSearch.find(text, in: catalog)
                        return (found, try CatalogSearch.channels(text, in: catalog))
                    }
                    let (found, live) = try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
                    try Task.checkCancellation()
                    results = found; channels = live; localBusy = false
                } catch { if !Task.isCancelled { localBusy = false } }
            }
            .task(id: "\(query):\(searchRetry):\(store.libraryEpoch)") {
                remoteMessage = nil; remoteBusy = false
                guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                do {
                    try await Task.sleep(for: .milliseconds(350)); remoteBusy = true
                    _ = try await store.searchWebsites(query)
                    if !Task.isCancelled { remoteBusy = false }
                } catch is CancellationError { }
                catch { if !Task.isCancelled { remoteBusy = false; remoteMessage = store.safeMessage(error) } }
            }
    }
    /// Before typing: what you are watching, picks, and a short selection of the library.
    @ViewBuilder private var suggestions: some View {
        if results.isEmpty {
            EmptyPanel(title: "Nothing to search yet", message: "Connect a source to search your films and series here.", icon: "magnifyingglass").padding(.horizontal, 20)
        } else {
            let watching = Array(store.continueWatching.prefix(12))
            if !watching.isEmpty { ShelfRow(title: "Continue Watching") { ForEach(watching) { item in ResumeCard(media: item).frame(width: 240) } } }
            let picks = shelves.shelves.picks.prefix(20).compactMap { store.media($0) }
            if !picks.isEmpty {
                ShelfRow(title: "Picks for You", note: "Based on titles you watched or saved") {
                    ForEach(picks) { item in
                        NavigationLink { MediaDetailView(media: item) } label: { PosterCard(media: item) }.buttonStyle(PressStyle()).contextMenu { MediaActions(media: item) }.frame(width: 120)
                    }
                }
            }
            group("In Your Library", Array(results.prefix(24)), count: results.count)
        }
    }
    private func group(_ title: String, _ items: [Media], count: Int? = nil) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeading(title: title, count: count ?? items.count)
            LazyVStack(spacing: 14) {
                ForEach(items) { item in
                    NavigationLink { MediaDetailView(media: item) } label: { MediaRow(media: item) }.buttonStyle(PressStyle()).contextMenu { MediaActions(media: item) }.accessibilityIdentifier("search-result-\(item.providerID)")
                }
            }.padding(.horizontal, 20)
        }
    }
}

private struct LocalSearchKey: Equatable {
    let query: String
    let revision: Int
    let epoch: UUID
}

enum CatalogSearch {
    nonisolated static func find(_ query: String, in catalog: [Media]) throws -> [Media] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var found: [Media] = []
        for (index, item) in catalog.enumerated() {
            if index.isMultiple(of: 256) { try Task.checkCancellation() }
            guard item.kind == .movie || item.kind == .series else { continue }
            if query.isEmpty || "\(item.title) \(item.seriesTitle ?? "") \(item.overview)".localizedCaseInsensitiveContains(query) { found.append(item) }
        }
        try Task.checkCancellation()
        let ordered = found.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        try Task.checkCancellation()
        return ordered
    }
    /// Channels whose name or group matches; empty for an empty query.
    nonisolated static func channels(_ query: String, in catalog: [Media], limit: Int = 50) throws -> [Media] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        var found: [Media] = []
        for (index, item) in catalog.enumerated() where found.count < limit {
            if index.isMultiple(of: 256) { try Task.checkCancellation() }
            if item.kind == .channel, "\(item.title) \(item.group ?? "")".localizedCaseInsensitiveContains(query) { found.append(item) }
        }
        return found
    }
}
struct MediaRow: View {
    let media: Media
    var trailing = "chevron.right"
    var body: some View {
        HStack(spacing: 16) {
            ArtView(media: media).frame(width: 62, height: media.kind == .channel ? 62 : 86).clipShape(RoundedRectangle(cornerRadius: OxaTheme.radiusSmall))
            VStack(alignment: .leading, spacing: 6) { Text(media.displayTitle).font(.body.weight(.semibold)).foregroundStyle(.white); Text(media.kind == .episode ? "\(media.episodeLabel) · \(media.title)" : media.kind == .channel ? media.group ?? "Live TV" : [media.year.map(String.init), media.episodeLabel].compactMap { $0 }.joined(separator: " · ")).font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(2) }
            Spacer(minLength: 0)
            Image(systemName: trailing).font(.caption).foregroundStyle(OxaTheme.secondary)
        }.accessibilityElement(children: .combine)
    }
}

struct UpdateBanner: View {
    @Environment(AppStore.self) private var store
    let release: AppRelease
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Oxa’s Library \(release.version) is available").font(.headline)
            Text("Download the new IPA and install it with the same signing identity. Your library stays in place.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
            HStack(spacing: 16) {
                Link("Download", destination: release.page).font(.subheadline.weight(.semibold)).buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
                Button("Later") { store.skipUpdate() }.font(.subheadline)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(16).background(OxaTheme.raised, in: RoundedRectangle(cornerRadius: 18))
    }
}
