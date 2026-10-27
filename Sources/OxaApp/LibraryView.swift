import SwiftUI

struct LibraryView: View {
    @Environment(AppStore.self) private var store
    @State private var selectedSource: UUID?
    @State private var type = "All"
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize = 30
    @ScaledMetric(relativeTo: .largeTitle) private var welcomeSize = 32
    private var visible: [Media] { store.catalog.filter { [.movie, .series].contains($0.kind) && (selectedSource == nil || $0.sourceID == selectedSource) && (type == "All" || type == "Movies" && $0.kind == .movie || type == "Series" && $0.kind == .series) } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack(spacing: 10) {
                    OxaMark(size: 25)
                    Text("Oxa’s Library").font(.headline)
                    Spacer()
                    Button { store.showAddSource = true } label: { Image(systemName: "plus").frame(width: 44, height: 44) }.accessibilityLabel("Add source")
                }.padding(.horizontal, 20)
                if !store.refreshing.isEmpty { Label("Refreshing sources… You can keep browsing.", systemImage: "arrow.trianglehead.2.clockwise.rotate.90").font(.caption).foregroundStyle(OxaTheme.secondary).padding(.horizontal, 20) }
                if store.preview {
                    HStack { Text("Preview library · illustrative titles").font(.caption).foregroundStyle(OxaTheme.secondary); Spacer(); Button("Exit") { store.leavePreview() }.font(.caption.weight(.semibold)) }.padding(.horizontal, 20)
                }
                if store.sources.isEmpty { firstRun }
                else {
                    HStack {
                        Text("Library").font(.system(size: titleSize, weight: .bold)).tracking(-0.6)
                        Spacer()
                        Menu { Button("All sources") { selectedSource = nil }; ForEach(store.sources) { source in Button(source.name) { selectedSource = source.id } } } label: {
                            Label(selectedSource.flatMap { store.source($0)?.name } ?? "All sources", systemImage: "line.3.horizontal.decrease").font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(1)
                        }
                    }.padding(.horizontal, 20)
                    if !store.newEpisodes.isEmpty {
                        VStack(spacing: 14) {
                            SectionHeading(title: "New Episodes")
                            ScrollView(.horizontal, showsIndicators: false) {
                                LazyHStack(spacing: 16) { ForEach(store.newEpisodes.filter { selectedSource == nil || $0.sourceID == selectedSource }) { item in ResumeCard(media: item, isNew: true).frame(width: 340) } }.padding(.horizontal, 20)
                            }
                        }
                    }
                    if !store.continueWatching.isEmpty {
                        VStack(spacing: 14) {
                            SectionHeading(title: "Continue Watching")
                            ScrollView(.horizontal, showsIndicators: false) {
                                LazyHStack(spacing: 16) { ForEach(store.continueWatching.filter { selectedSource == nil || $0.sourceID == selectedSource }) { item in ResumeCard(media: item).containerRelativeFrame(.horizontal) { width, _ in store.continueWatching.count == 1 ? width - 40 : min(340, width - 40) } } }.padding(.horizontal, 20)
                            }
                        }
                    }
                    Picker("Media type", selection: $type) { Text("All").tag("All"); Text("Movies").tag("Movies"); Text("Series").tag("Series") }.pickerStyle(.segmented).padding(.horizontal, 20)
                    if visible.isEmpty {
                        EmptyPanel(title: "No titles here yet", message: "Add a movie or series source, or choose another filter. Your live channels are in IPTV.", icon: "film").padding(.horizontal, 20)
                    } else {
                        SectionHeading(title: type == "All" ? "Your Collection" : type, count: visible.count)
                        // Two equal columns: (available width − 40pt margins − 16pt gap) / 2.
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)], alignment: .leading, spacing: 24) {
                            ForEach(visible) { item in NavigationLink { MediaDetailView(media: item) } label: { PosterCard(media: item) }.buttonStyle(PressStyle()).accessibilityIdentifier("media-card-\(item.providerID)") }
                        }.padding(.horizontal, 20)
                    }
                    ForEach((store.state.websitePages ?? []).filter { $0.cursor != nil && $0.catalog.type != "live" && (selectedSource == nil || $0.sourceID == selectedSource) && (type == "All" || type == "Movies" && $0.catalog.type == "video" || type == "Series" && $0.catalog.type == "series") }) { page in
                        Button { Task { await store.loadWebsitePage(page) } } label: {
                            HStack { if store.loadingWebsitePages.contains(page.id) { ProgressView() }; Label("Load More · \(page.catalog.name)", systemImage: "arrow.down"); Spacer(); Text(store.source(page.sourceID)?.name ?? "").foregroundStyle(OxaTheme.secondary).font(.caption) }.padding(16).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        }.disabled(store.loadingWebsitePages.contains(page.id)).accessibilityIdentifier("load-more-\(page.addonID)-\(page.catalog.id)").padding(.horizontal, 20)
                    }
                    ForEach(store.sources.filter { store.notices[$0.id] != nil }) { source in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(store.notices[source.id] ?? "").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                            Button("Retry \(source.name)") { Task { await store.refresh(source) } }.disabled(store.refreshing.contains(source.id))
                        }.padding(20).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 16)).padding(.horizontal, 20)
                    }
                }
            }.padding(.top, 8).padding(.bottom, 28)
        }.background(.black).toolbar(.hidden, for: .navigationBar).refreshable { store.startRefresh() }
    }
    private var firstRun: some View {
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 16) {
                Text("A home for\nyour collection.").font(.system(size: welcomeSize, weight: .bold)).tracking(-0.8).fixedSize(horizontal: false, vertical: true)
                Text("Your films, series and live TV.\nConnected to the sources you choose.").font(.body).foregroundStyle(OxaTheme.secondary).lineSpacing(4)
            }.padding(.top, 20)
            PrimaryAction(title: "Add Your First Source", icon: "plus") { store.showAddSource = true }
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
                if isNew { Text("Play Episode").font(.subheadline.weight(.semibold)) } else {
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
        VStack(alignment: .leading, spacing: 10) {
            ArtView(media: media).aspectRatio(2 / 3, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 12))
            Text(media.title).font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(2)
            Text([media.year.map(String.init), media.kind == .series ? "Series" : "Film", store.source(media.sourceID)?.name].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(OxaTheme.secondary).lineLimit(2)
        }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
    }
}
struct SearchView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""
    @State private var remoteBusy = false
    @State private var remoteMessage: String?
    @State private var searchRetry = 0
    private var results: [Media] { store.catalog.filter { [.movie, .series].contains($0.kind) && (query.isEmpty || "\($0.title) \($0.seriesTitle ?? "") \($0.overview)".localizedCaseInsensitiveContains(query)) }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending } }
    var body: some View {
        ScrollView {
            if remoteBusy { ProgressView("Searching connected libraries…").padding(20) }
            if let remoteMessage { VStack(spacing: 8) { Text(remoteMessage).font(.subheadline).foregroundStyle(OxaTheme.secondary); Button("Retry") { searchRetry += 1 } }.padding(20) }
            if results.isEmpty { EmptyPanel(title: query.isEmpty ? "Find your next watch" : "No matching titles", message: query.isEmpty ? "Connect a source to search your films and series here." : "Try a different title or refresh your media sources.", icon: "magnifyingglass").padding(20) }
            else { LazyVStack(spacing: 18) { ForEach(results) { item in NavigationLink { MediaDetailView(media: item) } label: { MediaRow(media: item) }.buttonStyle(PressStyle()).accessibilityIdentifier("search-result-\(item.providerID)") } }.padding(20) }
        }.background(.black).navigationTitle("Search").navigationBarTitleDisplayMode(.inline).searchable(text: $query, prompt: "Films and series")
            .task(id: "\(query):\(searchRetry)") {
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
