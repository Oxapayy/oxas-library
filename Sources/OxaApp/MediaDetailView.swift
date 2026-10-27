import SwiftUI
import UniformTypeIdentifiers

struct MediaDetailView: View {
    @Environment(AppStore.self) private var store
    let media: Media
    @State private var selectedSeason = 1
    @State private var importingCaption = false
    @State private var captionTarget: Media?
    @State private var findingArtwork = false
    @ScaledMetric(relativeTo: .title) private var titleSize = 28
    private var current: Media { store.media(media.id) ?? media }
    private var episodes: [Media] { store.episodes(media) }
    private var seasons: [Int] { Array(Set(episodes.map { $0.season ?? 1 } + (current.websiteItem?.seasons.map(\.number) ?? []))).sorted() }
    private var target: Media? {
        guard media.kind == .series else { return current }
        let resume = store.continueWatching.first { $0.sourceID == media.sourceID && $0.seriesID == media.providerID }
        return resume ?? episodes.first { store.state.progress[$0.id]?.completed != true } ?? episodes.first
    }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                ArtView(media: current, wide: true).frame(height: 235).clipShape(RoundedRectangle(cornerRadius: 16))
                VStack(alignment: .leading, spacing: 10) {
                    Text(current.displayTitle).font(.system(size: titleSize, weight: .bold)).tracking(-0.5)
                    Text([current.year.map(String.init), media.kind == .episode ? media.episodeLabel : media.episodeLabel, current.duration.boundedDuration > 0 ? "\(Int(current.duration.boundedDuration / 60)) min" : nil].compactMap { $0 }.joined(separator: " · ")).font(.subheadline).foregroundStyle(OxaTheme.secondary)
                    if let source = store.source(media.sourceID) { Text(source.name).font(.caption).foregroundStyle(OxaTheme.secondary) }
                }
                if let target {
                    let saved = store.state.progress[target.id]
                    PrimaryAction(title: saved != nil && saved?.completed == false ? "Resume at \(saved!.seconds.clock)" : "Play", icon: "play.fill") { Task { await store.play(target) } }
                    if target.kind == .episode && media.kind == .series { Text("\(target.episodeLabel) · \(target.title)").font(.subheadline).foregroundStyle(OxaTheme.secondary) }
                    if media.kind != .series { downloadButton(target) }
                } else if media.kind == .series { Text("Loading episodes…").foregroundStyle(OxaTheme.secondary) }
                if media.websiteItem != nil { Text("Catalog information is provided by this website and its linked providers. Stream availability is checked when you press Play.").font(.caption).foregroundStyle(OxaTheme.secondary) }
                if !current.overview.isEmpty { Text(current.overview).font(.body).lineSpacing(4).foregroundStyle(OxaTheme.secondary) }
                if media.kind == .series {
                    HStack {
                        Text("Episodes").font(.title3.weight(.semibold))
                        Spacer()
                        if !seasons.isEmpty { Picker("Season", selection: $selectedSeason) { ForEach(seasons, id: \.self) { Text("Season \($0)").tag($0) } }.tint(.white) }
                    }
                    if !episodes.isEmpty {
                        Button { store.downloadSeason(episodes.filter { ($0.season ?? 1) == selectedSeason }) } label: { Label("Download Season \(selectedSeason)", systemImage: "arrow.down.circle").frame(minHeight: 44) }.disabled(store.preview)
                        ForEach(episodes.filter { ($0.season ?? 1) == selectedSeason }) { episode in episodeRow(episode) }
                    } else { Text("No episodes were returned by this source.").font(.subheadline).foregroundStyle(OxaTheme.secondary) }
                }
                if current.kind == .movie || current.kind == .episode {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Subtitles").font(.headline)
                        Text("Choose embedded English or German tracks in the player, or attach an SRT / WebVTT file.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                        Button { captionTarget = current; importingCaption = true } label: { Label("Import Subtitle File", systemImage: "text.badge.plus").frame(minHeight: 44) }.disabled(store.preview)
                        if current.subtitlePath != nil {
                            Text("An external subtitle file is attached.").font(.caption).foregroundStyle(OxaTheme.secondary)
                            Button("Remove External Subtitles", role: .destructive) { removeCaption(current) }
                        }
                    }
                }
                if store.state.preferences.externalMetadata && !store.preview { Button { findingArtwork = true } label: { Label("Find Cover & Description", systemImage: "photo").frame(minHeight: 44) } }
            }.padding(20)
        }.background(.black).navigationTitle(media.kind == .series ? "Series" : "Details").navigationBarTitleDisplayMode(.inline)
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
    private func downloadButton(_ item: Media) -> some View {
        let state = store.state.transfers.first { $0.id == item.id }?.state
        return Button {
            if state == .ready { store.selectedTab = 3 } else { store.download(item) }
        } label: { Label(state == .ready ? "Saved for Offline" : state == .downloading || state == .queued ? "Downloading…" : "Download", systemImage: state == .ready ? "checkmark.circle" : "arrow.down.circle").font(.body.weight(.medium)).frame(maxWidth: .infinity, minHeight: 44) }.buttonStyle(PressStyle()).disabled(store.preview || state == .downloading || state == .queued)
    }
    private func episodeRow(_ item: Media) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.episodeLabel).font(.caption).foregroundStyle(OxaTheme.secondary)
                    Text(item.title).font(.body.weight(.semibold))
                    if let saved = store.state.progress[item.id] { Text(saved.completed ? "Watched" : "Resume at \(saved.seconds.clock)").font(.caption).foregroundStyle(OxaTheme.secondary) }
                }
                Spacer()
                Button { Task { await store.play(item) } } label: { Image(systemName: "play.fill").frame(width: 44, height: 44).background(OxaTheme.raised, in: Circle()) }.accessibilityLabel("Play \(item.title)")
            }
            if !item.overview.isEmpty { Text(item.overview).font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(3) }
            HStack { downloadButton(item); Button { captionTarget = item; importingCaption = true } label: { Image(systemName: "captions.bubble").frame(width: 44, height: 44) }.accessibilityLabel("Import subtitles for \(item.title)").disabled(store.preview) }
        }.padding(16).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 16))
    }
}
