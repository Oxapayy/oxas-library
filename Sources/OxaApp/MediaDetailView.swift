import SwiftUI
import UniformTypeIdentifiers

struct MediaDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.colorSchemeContrast) private var contrast
    let media: Media
    @State private var selectedSeason = 1
    @State private var importingCaption = false
    @State private var captionTarget: Media?
    @State private var findingArtwork = false
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize = 34
    private var current: Media { store.media(media.id) ?? media }
    private var episodes: [Media] { store.episodes(media) }
    private var seasons: [Int] { Array(Set(episodes.map { $0.season ?? 1 } + (current.websiteItem?.seasons.map(\.number) ?? []))).sorted() }
    private var target: Media? {
        guard media.kind == .series else { return current }
        let resume = store.continueWatching.first { $0.sourceID == media.sourceID && $0.seriesID == media.providerID }
        return resume ?? episodes.first { store.state.progress[$0.id]?.completed != true } ?? episodes.first
    }
    var body: some View {
        let watchItem = media.kind == .episode ? store.catalog.first { $0.kind == .series && $0.sourceID == media.sourceID && $0.providerID == media.seriesID } ?? current : current
        let listed = store.state.favorites.contains(watchItem.id)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                ZStack(alignment: .bottomLeading) {
                    // Top scrim keeps the back button readable on bright art.
                    ArtView(media: current, wide: false, titled: false).frame(height: 520).frame(maxWidth: .infinity).overlay(alignment: .top) { OxaTheme.topScrim(contrast).frame(height: 140) }
                    OxaTheme.bottomScrim(contrast)
                    VStack(alignment: .leading, spacing: 10) {
                        Text(current.displayTitle).font(.system(size: titleSize, weight: .bold)).tracking(-0.6).foregroundStyle(.white).lineLimit(3).minimumScaleFactor(0.75)
                        Text([current.year.map(String.init), media.kind == .series ? "Series" : media.kind == .episode ? "\(media.episodeLabel) · \(current.title)" : "Film", current.duration.boundedDuration > 0 ? "\(Int(current.duration.boundedDuration / 60)) min" : nil, store.source(media.sourceID)?.name].compactMap { $0 }.joined(separator: " · ")).font(.subheadline.weight(.medium)).foregroundStyle(.white.opacity(0.78)).lineLimit(2)
                    }.padding(.horizontal, 20).padding(.bottom, 4)
                }
                VStack(alignment: .leading, spacing: 16) {
                    if let target {
                        let saved = store.state.progress[target.id]
                        let resuming = saved.map { !$0.completed && $0.seconds > 0 } ?? false
                        HStack(spacing: 10) {
                            Button { Task { await store.play(target) } } label: {
                                Label(resuming ? "Resume at \(saved!.seconds.clock)" : "Play", systemImage: "play.fill").font(.headline).frame(maxWidth: .infinity, minHeight: 52).background(OxaTheme.onWhite, in: Capsule()).foregroundStyle(.black)
                            }.buttonStyle(PressStyle())
                            HStack(spacing: 0) {
                                Button { store.toggleFavorite(watchItem) } label: { Image(systemName: listed ? "checkmark" : "plus").frame(width: 52, height: 52) }
                                    .accessibilityLabel(listed ? "Remove \(watchItem.title) from watchlist" : "Add \(watchItem.title) to watchlist")
                                if media.kind != .series {
                                    Rectangle().fill(.white.opacity(0.2)).frame(width: 1, height: 22)
                                    downloadIcon(target)
                                }
                            }.font(.body.weight(.semibold)).foregroundStyle(.white).glassPill(Capsule())
                        }
                        if resuming, let saved {
                            VStack(alignment: .leading, spacing: 6) {
                                if target.kind == .episode && media.kind == .series { Text("\(target.episodeLabel) · \(target.title)").font(.subheadline.weight(.medium)) }
                                ProgressView(value: saved.fraction).tint(OxaTheme.accent).accessibilityLabel("Watch progress")
                                Text("\(max(0, saved.duration - saved.seconds).clock) left").font(.caption).monospacedDigit().foregroundStyle(OxaTheme.secondary)
                            }
                        } else if target.kind == .episode && media.kind == .series { Text("Starts with \(target.episodeLabel) · \(target.title)").font(.subheadline).foregroundStyle(OxaTheme.secondary) }
                    } else if media.kind == .series { Label("Loading episodes…", systemImage: "hourglass").foregroundStyle(OxaTheme.secondary) }
                    if !current.overview.isEmpty { Text(current.overview).font(.body).lineSpacing(4).foregroundStyle(.white.opacity(0.82)) }
                    if media.websiteItem != nil { Text("Catalog information is provided by this website and its linked providers. Stream availability is checked when you press Play.").font(.caption).foregroundStyle(OxaTheme.secondary) }
                }.padding(.horizontal, 20)
                if media.kind == .series {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Text("Episodes").font(.title3.weight(.semibold))
                            Spacer()
                            if !episodes.isEmpty {
                                Button { store.downloadSeason(episodes.filter { ($0.season ?? 1) == selectedSeason }) } label: { Label("Download season", systemImage: "arrow.down.circle").font(.subheadline).frame(minHeight: 44) }.disabled(store.preview)
                            }
                        }.padding(.horizontal, 20)
                        if seasons.count > 1 { SeasonBar(seasons: seasons, selection: $selectedSeason).padding(.horizontal, 16) }
                        if !episodes.isEmpty {
                            VStack(spacing: 20) { ForEach(episodes.filter { ($0.season ?? 1) == selectedSeason }) { episode in episodeRow(episode) } }.padding(.horizontal, 20)
                        } else { Text("No episodes were returned by this source.").font(.subheadline).foregroundStyle(OxaTheme.secondary).padding(.horizontal, 20) }
                    }
                }
                MoreLikeThis(seedID: media.kind == .episode ? watchItem.id : current.id)
                if current.kind == .movie || current.kind == .episode {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Subtitles").font(.headline)
                        Text("Choose embedded English or German tracks in the player, or attach an SRT / WebVTT file.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                        Button { captionTarget = current; importingCaption = true } label: { Label("Import Subtitle File", systemImage: "text.badge.plus").frame(minHeight: 44) }.disabled(store.preview)
                        if current.subtitlePath != nil {
                            Text("An external subtitle file is attached.").font(.caption).foregroundStyle(OxaTheme.secondary)
                            Button("Remove External Subtitles", role: .destructive) { removeCaption(current) }
                        }
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 20)).padding(.horizontal, 16)
                }
                if store.state.preferences.externalMetadata && !store.preview { Button { findingArtwork = true } label: { Label("Find Cover & Description", systemImage: "photo").frame(minHeight: 44) }.padding(.horizontal, 20) }
            }.padding(.bottom, 28)
        }.background(OxaTheme.ground).ignoresSafeArea(edges: .top).navigationTitle("").navigationBarTitleDisplayMode(.inline).toolbarBackground(.hidden, for: .navigationBar)
            .task {
                if media.kind == .series { await store.loadEpisodes(media); selectedSeason = seasons.first(where: { $0 > 0 }) ?? seasons.first ?? 1 }
                else if media.websiteItem != nil { await store.loadWebsiteDetails(media) }
            }
            .onChange(of: selectedSeason) { _, number in if media.websiteItem != nil { Task { await store.loadWebsiteSeason(current, number: number) } } }
            .sheet(isPresented: $findingArtwork) { MetadataSearch(media: current).environment(store) }
            .fileImporter(isPresented: $importingCaption, allowedContentTypes: [.plainText, UTType(filenameExtension: "srt") ?? .data, UTType(filenameExtension: "vtt") ?? .data]) { result in
                do {
                    let url = try result.get(); let accessed = url.startAccessingSecurityScopedResource(); defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                    let data = try Data(contentsOf: url)
                    guard data.count < 10_000_000, let text = String(data: data, encoding: .utf8), !CaptionParser.parse(text).isEmpty else { throw OxaError.message("Choose a valid UTF-8 SRT or WebVTT subtitle file.") }
                    guard let root = store.disk?.mediaRoot, let target = captionTarget else { return }
                    let filename = UUID().uuidString + ".vtt"; try data.write(to: root.appendingPathComponent(filename), options: .atomic)
                    if let index = store.state.media.firstIndex(where: { $0.id == target.id }) { store.state.media[index].subtitlePath = filename }
                    if let index = store.state.transfers.firstIndex(where: { $0.id == target.id }) { store.state.transfers[index].media.subtitlePath = filename }
                    store.save()
                } catch { store.error = store.safeMessage(error) }
            }
    }
    private func removeCaption(_ item: Media) {
        guard let root = store.disk?.mediaRoot, let path = item.subtitlePath, let url = URLPolicy.relativeFile(path, root: root) else { return }
        do {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            if let index = store.state.media.firstIndex(where: { $0.id == item.id }) { store.state.media[index].subtitlePath = nil }
            if let index = store.state.transfers.firstIndex(where: { $0.id == item.id }) { store.state.transfers[index].media.subtitlePath = nil }
            store.save()
        } catch { store.error = "Could not remove this subtitle file." }
    }
    private func downloadIcon(_ item: Media, identifier: String = "Download", size: CGFloat = 52) -> some View {
        let state = store.state.transfers.first { $0.id == item.id }?.state
        return Button {
            if state == .ready { store.selectedTab = 3 } else { store.download(item) }
        } label: {
            Group { if state == .downloading || state == .queued { ProgressView().tint(.white) } else { Image(systemName: state == .ready ? "checkmark.circle" : "arrow.down.to.line") } }.frame(width: size, height: size)
        }.disabled(store.preview || state == .downloading || state == .queued)
            .accessibilityLabel(state == .ready ? "Saved for offline, open Downloads" : state == .downloading || state == .queued ? "Downloading \(item.title)" : "Download \(item.title)")
            .accessibilityIdentifier(identifier)
    }
    private func episodeRow(_ item: Media) -> some View {
        let saved = store.state.progress[item.id]
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Button { Task { await store.play(item) } } label: {
                        Color.clear.aspectRatio(16 / 9, contentMode: .fit).overlay { ArtView(media: item, wide: true) }
                            .overlay(alignment: .bottomLeading) { Image(systemName: "play.fill").font(.caption).foregroundStyle(.black).frame(width: 28, height: 28).background(OxaTheme.onWhite, in: Circle()).padding(8) }
                            .clipShape(RoundedRectangle(cornerRadius: OxaTheme.radiusCard)).overlay(RoundedRectangle(cornerRadius: OxaTheme.radiusCard).stroke(OxaTheme.hairline(contrast)))
                    }.buttonStyle(PressStyle()).accessibilityLabel("Play \(item.title)")
                    // Watch progress sits under the thumbnail, not on the art.
                    if let saved, saved.seconds > 0, !saved.completed { ProgressLine(fraction: saved.fraction) }
                }.frame(width: 140)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.episodeLabel).font(.caption).foregroundStyle(OxaTheme.secondary)
                    Text(item.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                    if let saved { Text(saved.completed ? "Watched" : "Resume at \(saved.seconds.clock)").font(.caption).foregroundStyle(OxaTheme.secondary) }
                }
                Spacer(minLength: 0)
            }
            if !item.overview.isEmpty { Text(item.overview).font(.footnote).foregroundStyle(OxaTheme.secondary).lineLimit(3) }
            HStack(spacing: 4) {
                downloadIcon(item, identifier: "download-\(item.providerID)", size: 44)
                Button { captionTarget = item; importingCaption = true } label: { Image(systemName: "captions.bubble").frame(width: 44, height: 44) }.accessibilityLabel("Import subtitles for \(item.title)").disabled(store.preview)
            }.font(.subheadline).foregroundStyle(OxaTheme.secondary)
        }
    }
}

private struct SeasonBar: View {
    let seasons: [Int]
    @Binding var selection: Int
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(seasons, id: \.self) { number in
                    let active = number == selection
                    Button { selection = number } label: {
                        ChipLabel(title: "Season \(number)", active: active)
                    }.accessibilityAddTraits(active ? .isSelected : [])
                }
            }.padding(4)
        }.glassPill(Capsule()).clipShape(Capsule()).fixedSize(horizontal: false, vertical: true)
    }
}

/// Its own view, so download progress on the detail page does not rerun the
/// similarity scoring; it only depends on the seed and the shared index.
private struct MoreLikeThis: View {
    @Environment(AppStore.self) private var store
    @Environment(ShelfModel.self) private var shelves
    let seedID: String
    var body: some View {
        let similar = (shelves.index.map { Shelves.moreLikeThis($0, seedID) } ?? []).compactMap { store.media($0) }
        if !similar.isEmpty {
            ShelfRow(title: "More Like This") {
                ForEach(similar) { item in
                    NavigationLink { MediaDetailView(media: item) } label: { PosterCard(media: item) }.buttonStyle(PressStyle()).contextMenu { MediaActions(media: item) }.frame(width: 120).accessibilityIdentifier("more-like-\(item.providerID)")
                }
            }
        }
    }
}
