import SwiftUI

struct LibraryView: View {
    @Environment(AppStore.self) private var store
    @State private var selectedSource: UUID?
    @State private var type = "All"
    @State private var importing = false
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize = 30
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
        let visible = visible
        let newEpisodes = store.newEpisodes.filter { selectedSource == nil || $0.sourceID == selectedSource }
        let continueWatching = store.continueWatching.filter { selectedSource == nil || $0.sourceID == selectedSource }
        let featured = type == "All" ? continueWatching.first ?? visible.first : visible.first
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if store.sources.isEmpty {
                    HStack(spacing: 10) {
                        OxaMark(size: 25)
                        Text("Oxa’s Library").font(.headline)
                    }.frame(minHeight: 44).padding(.horizontal, 20)
                } else {
                    HStack(spacing: 8) {
                        CategoryBar(selection: $type) { store.selectedTab = 2 }
                        Button { store.showAddSource = true } label: { Image(systemName: "plus").font(.body.weight(.semibold)).frame(width: 48, height: 48).glassPill(Circle()) }.buttonStyle(PressStyle()).accessibilityLabel("Add source")
                    }.padding(.horizontal, 16)
                    if store.sources.count > 1 {
                        Menu { Button("All sources") { selectedSource = nil }; ForEach(store.sources) { source in Button(source.name) { selectedSource = source.id } } } label: {
                            Label(selectedSource.flatMap { store.source($0)?.name } ?? "All sources", systemImage: "line.3.horizontal.decrease").font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(1).frame(minHeight: 44)
                        }.accessibilityLabel("Filter by source").padding(.horizontal, 20).padding(.top, -16)
                    }
                }
                if !store.refreshing.isEmpty { Label("Refreshing sources… You can keep browsing.", systemImage: "arrow.trianglehead.2.clockwise.rotate.90").font(.caption).foregroundStyle(OxaTheme.secondary).padding(.horizontal, 20) }
                if let update = store.availableUpdate { UpdateBanner(release: update).padding(.horizontal, 20) }
                if store.preview {
                    HStack { Text("Preview library · illustrative titles").font(.caption).foregroundStyle(OxaTheme.secondary); Spacer(); Button("Exit Preview") { store.leavePreview() }.font(.caption.weight(.semibold)).frame(minHeight: 44) }.padding(.horizontal, 20)
                }
                if store.sources.isEmpty { firstRun }
                else {
                    if let featured {
                        VStack(alignment: .leading, spacing: 12) {
                            if featured.id == continueWatching.first?.id { SectionHeading(title: "Continue Watching") }
                            HeroCard(media: featured).padding(.horizontal, 16)
                        }
                    }
                    if type == "All" {
                        let moreWatching = Array(continueWatching.dropFirst())
                        if !moreWatching.isEmpty {
                            ShelfRow(title: "Also watching") { ForEach(moreWatching) { item in ResumeCard(media: item).frame(width: 280) } }
                        }
                        if !newEpisodes.isEmpty {
                            ShelfRow(title: "New Episodes") { ForEach(newEpisodes) { item in ResumeCard(media: item, isNew: true).frame(width: 280) } }
                        }
                        let watchlist = visible.filter { store.state.favorites.contains($0.id) }
                        if !watchlist.isEmpty { posterRow("Watchlist", watchlist) }
                        let movies = visible.filter { $0.kind == .movie }, series = visible.filter { $0.kind == .series }
                        if !movies.isEmpty { posterRow("Movies", movies) }
                        if !series.isEmpty { posterRow("Series", series) }
                    } else if !visible.isEmpty {
                        SectionHeading(title: type, count: visible.count)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), alignment: .leading, spacing: 20) {
                            ForEach(visible) { item in posterLink(item) }
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
            }.padding(.top, 8).padding(.bottom, 28)
        }.background(OxaTheme.ground).toolbar(.hidden, for: .navigationBar).refreshable { store.startRefresh(force: true) }
    }
    private func posterRow(_ title: String, _ items: [Media]) -> some View {
        ShelfRow(title: title, count: items.count) { ForEach(items) { item in posterLink(item).frame(width: 120) } }
    }
    private func posterLink(_ item: Media) -> some View {
        NavigationLink { MediaDetailView(media: item) } label: { PosterCard(media: item) }.buttonStyle(PressStyle()).accessibilityIdentifier("media-card-\(item.providerID)")
    }
    private var firstRun: some View {
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 16) {
                Text("A home for\nyour collection.").font(.system(size: welcomeSize, weight: .bold)).tracking(-0.8).fixedSize(horizontal: false, vertical: true)
                Text("Your films, series and live TV.\nConnected to the sources you choose.").font(.body).foregroundStyle(OxaTheme.secondary).lineSpacing(4)
            }.padding(.top, 20)
            PrimaryAction(title: importing ? "Importing…" : "Import huhu.to", icon: "plus") {
                importing = true
                Task { defer { importing = false }; do { try await store.addSource(name: "huhu.to", kind: .website, credentials: Credentials(endpoint: "https://huhu.to"), allowHTTP: false) } catch { store.error = store.safeMessage(error) } }
            }.disabled(importing)
            Button("Connect Your Own Server") { store.showAddSource = true }.font(.subheadline.weight(.medium)).frame(maxWidth: .infinity)
            VStack(alignment: .leading, spacing: 24) {
                sourceRow("Your libraries", subtitle: "Website catalogs, Plex, Jellyfin and Emby", icon: "server.rack")
                sourceRow("Your own files", subtitle: "NAS via WebDAV and video URLs", icon: "externaldrive")
                sourceRow("Your live channels", subtitle: "M3U playlists and Xtream Codes", icon: "tv")
            }.padding(24).frame(maxWidth: .infinity, alignment: .leading).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 20))
            HStack(alignment: .top, spacing: 10) { Image(systemName: "lock"); Text("Your watch history stays on this iPhone.\nNo Oxa account needed.").fixedSize(horizontal: false, vertical: true) }.font(.subheadline).foregroundStyle(OxaTheme.secondary)
            Button("Explore a Preview Library") { store.enablePreview() }.font(.subheadline.weight(.medium)).frame(maxWidth: .infinity).padding(.vertical, 6)
        }.padding(.horizontal, 20)
    }
    private func sourceRow(_ title: String, subtitle: String, icon: String) -> some View {
        HStack(alignment: .top, spacing: 16) { Image(systemName: icon).font(.title3).foregroundStyle(OxaTheme.secondary).frame(width: 24); VStack(alignment: .leading, spacing: 5) { Text(title).font(.body.weight(.medium)); Text(subtitle).font(.subheadline).foregroundStyle(OxaTheme.secondary) } }
    }
}
struct ResumeCard: View {
    @Environment(AppStore.self) private var store
    let media: Media
    var isNew = false
    var body: some View {
        let progress = store.state.progress[media.id]
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .bottomLeading) {
                ArtView(media: media, wide: true).frame(height: 185)
                Button { Task { await store.play(media) } } label: { Image(systemName: "play.fill").font(.title3).foregroundStyle(.black).frame(width: 48, height: 48).background(.white, in: Circle()) }.buttonStyle(PressStyle()).padding(16).accessibilityLabel("Resume \(media.displayTitle) at \(progress?.seconds.clock ?? "0:00")")
            }
            VStack(alignment: .leading, spacing: 9) {
                HStack { Text(media.displayTitle).font(.headline).lineLimit(1); Spacer(); if store.localURL(media) != nil { Image(systemName: "arrow.down.circle.fill").foregroundStyle(OxaTheme.secondary) } }
                Text(media.kind == .episode ? "\(media.episodeLabel) · \(media.title)" : media.episodeLabel).font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(1)
                if isNew { Text("New episode").font(.caption).foregroundStyle(OxaTheme.secondary) } else {
                ProgressView(value: progress?.fraction ?? 0).tint(OxaTheme.accent).accessibilityLabel("Watch progress")
                HStack { Text(progress?.seconds.clock ?? "0:00"); Spacer(); Text("\(max(0, (progress?.duration ?? 0) - (progress?.seconds ?? 0)).clock) remaining") }.font(.caption).monospacedDigit().foregroundStyle(OxaTheme.secondary)
                }
            }.padding(16)
        }.background(OxaTheme.surface).clipShape(RoundedRectangle(cornerRadius: 16))
    }
}
struct PosterCard: View {
    @Environment(AppStore.self) private var store
    var media: Media
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ArtView(media: media).aspectRatio(2 / 3, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.08)))
            Text(media.title).font(.footnote.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
            Text([media.year.map(String.init), media.kind == .series ? "Series" : "Film"].compactMap { $0 }.joined(separator: " · ")).font(.caption2).foregroundStyle(OxaTheme.secondary).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
    }
}
struct SearchView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""
    @State private var remoteBusy = false
    @State private var remoteMessage: String?
    @State private var searchRetry = 0
    @State private var results: [Media] = []
    @State private var localBusy = false
    var body: some View {
        ScrollView {
            if remoteBusy { ProgressView("Searching connected libraries…").padding(20) }
            if let remoteMessage { VStack(spacing: 8) { Text(remoteMessage).font(.subheadline).foregroundStyle(OxaTheme.secondary); Button("Retry") { searchRetry += 1 } }.padding(20) }
            if localBusy && results.isEmpty { ProgressView("Searching your library…").padding(20) }
            else if results.isEmpty { EmptyPanel(title: query.isEmpty ? "Nothing to search yet" : "No matching titles", message: query.isEmpty ? "Connect a source to search your films and series here." : "Try a different title or refresh your media sources.", icon: "magnifyingglass").padding(20) }
            else { LazyVStack(spacing: 18) { ForEach(results) { item in NavigationLink { MediaDetailView(media: item) } label: { MediaRow(media: item) }.buttonStyle(PressStyle()).accessibilityIdentifier("search-result-\(item.providerID)") } }.padding(20) }
        }.background(OxaTheme.ground).navigationTitle("Search").navigationBarTitleDisplayMode(.inline).searchable(text: $query, prompt: "Films and series")
            .onChange(of: store.libraryEpoch) { results = [] }
            .task(id: LocalSearchKey(query: query, revision: store.state.catalogRevision, epoch: store.libraryEpoch)) {
                localBusy = true
                do {
                    if !query.isEmpty { try await Task.sleep(for: .milliseconds(120)) }
                    let catalog = store.catalog, text = query
                    let work = Task.detached(priority: .userInitiated) { try CatalogSearch.find(text, in: catalog) }
                    let found = try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
                    try Task.checkCancellation()
                    results = found; localBusy = false
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
}
struct MediaRow: View {
    let media: Media
    var body: some View {
        HStack(spacing: 16) {
            ArtView(media: media).frame(width: 62, height: 86).clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 6) { Text(media.displayTitle).font(.body.weight(.semibold)).foregroundStyle(.white); Text(media.kind == .episode ? "\(media.episodeLabel) · \(media.title)" : [media.year.map(String.init), media.episodeLabel].compactMap { $0 }.joined(separator: " · ")).font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(2) }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(OxaTheme.secondary)
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
