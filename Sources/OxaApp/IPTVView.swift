import SwiftUI

struct IPTVView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""
    @State private var favoritesOnly = false
    @State private var selectedGroup: String?
    @State private var guideChannel: Media?
    private var channels: [Media] { store.catalog.filter { $0.kind == .channel } }
    private var groups: [String] { Array(Set(channels.compactMap(\.group))).sorted() }
    private var visible: [Media] {
        channels.filter { item in
            (!favoritesOnly || store.state.favorites.contains(item.id)) && (selectedGroup == nil || item.group == selectedGroup) && (query.isEmpty || item.title.localizedCaseInsensitiveContains(query) || store.guide(item).contains { $0.title.localizedCaseInsensitiveContains(query) })
        }
    }
    var body: some View {
        let channels = channels
        let visible = visible
        let groups = groups
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if channels.isEmpty {
                    EmptyPanel(title: "Your live TV, together", message: "Connect an M3U playlist or Xtream Codes provider to watch your channels and explore the program guide.", icon: "tv")
                    PrimaryAction(title: "Add IPTV Source", icon: "plus") { store.showAddSource = true }
                } else {
                    HStack {
                        Button { favoritesOnly.toggle() } label: { Label(favoritesOnly ? "Favorites" : "All channels", systemImage: favoritesOnly ? "star.fill" : "star").font(.subheadline).frame(minHeight: 44) }
                        Spacer()
                        if !groups.isEmpty { Menu { Button("All groups") { selectedGroup = nil }; ForEach(groups, id: \.self) { group in Button(group) { selectedGroup = group } } } label: { Label(selectedGroup ?? "All groups", systemImage: "line.3.horizontal.decrease").font(.subheadline).lineLimit(1) } }
                    }
                    Text("\(visible.count) channels").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                    if visible.isEmpty { Text("No channels match this search or filter.").foregroundStyle(OxaTheme.secondary) }
                    LazyVStack(spacing: 12) { ForEach(visible) { channel in channelRow(channel) } }
                    ForEach((store.state.websitePages ?? []).filter { $0.catalog.type == "live" && $0.cursor != nil }) { page in
                        Button { Task { await store.loadWebsitePage(page) } } label: { Label("Load More Channels", systemImage: "arrow.down").frame(minHeight: 44) }.disabled(store.loadingWebsitePages.contains(page.id))
                    }
                    ForEach(store.sources.filter { ($0.kind.isTV || $0.kind == .website) && store.notices[$0.id] != nil }) { source in Text(store.notices[source.id] ?? "").font(.subheadline).foregroundStyle(OxaTheme.secondary) }
                }
            }.padding(20)
        }.background(.black).navigationTitle("IPTV").navigationBarTitleDisplayMode(.inline).searchable(text: $query, prompt: "Channels and programs")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { store.showAddSource = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add IPTV source") } }
            .sheet(item: $guideChannel) { channel in guide(channel) }
            .refreshable { for source in store.sources.filter({ $0.kind.isTV || $0.kind == .website }) { await store.refresh(source) } }
    }
    private func channelRow(_ channel: Media) -> some View {
        let now = store.guide(channel).first { $0.isNow }
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                Button { Task { await store.play(channel) } } label: {
                    HStack(spacing: 14) {
                        if let poster = channel.poster { SafeArtwork(url: poster, sourceID: channel.sourceID, mode: .fit, pixelSize: 132).frame(width: 44, height: 44) }
                        else { Image(systemName: "tv").font(.title2).frame(width: 44, height: 44).foregroundStyle(OxaTheme.secondary) }
                        VStack(alignment: .leading, spacing: 5) { Text(channel.title).font(.body.weight(.semibold)); Text(now?.title ?? "Live TV").font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(2) }
                        Spacer(minLength: 0)
                        Image(systemName: "play.fill").font(.subheadline)
                    }
                }.buttonStyle(PressStyle()).accessibilityIdentifier("play-channel-\(channel.providerID)")
                Button { store.toggleFavorite(channel) } label: { Image(systemName: store.state.favorites.contains(channel.id) ? "star.fill" : "star").frame(width: 44, height: 44) }.accessibilityLabel(store.state.favorites.contains(channel.id) ? "Remove \(channel.title) from favorites" : "Favorite \(channel.title)")
            }
            if let now {
                let fraction = min(1, max(0, Date.now.timeIntervalSince(now.start) / now.end.timeIntervalSince(now.start)))
                ProgressView(value: fraction).tint(OxaTheme.accent)
                HStack { Text(now.start, style: .time); Spacer(); Text(now.end, style: .time) }.font(.caption).foregroundStyle(OxaTheme.secondary)
            }
            Button { guideChannel = channel } label: { Label("Program Guide", systemImage: "list.bullet").font(.subheadline).frame(minHeight: 32) }
        }.padding(16).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 16))
    }
    private func guide(_ channel: Media) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    PrimaryAction(title: "Watch Live", icon: "play.fill") { guideChannel = nil; Task { await store.play(channel) } }
                    if store.guide(channel).isEmpty { EmptyPanel(title: "No program guide available", message: "Add an XMLTV guide URL in this source’s settings, or check the provider’s guide.", icon: "list.bullet") }
                    ForEach(store.guide(channel)) { program in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { Text(program.start, style: .time); Text("–"); Text(program.end, style: .time); Spacer(); if program.isNow { Text("Now").foregroundStyle(OxaTheme.accent) } }.font(.caption).foregroundStyle(OxaTheme.secondary)
                            Text(program.title).font(.headline)
                            if !program.overview.isEmpty { Text(program.overview).font(.subheadline).foregroundStyle(OxaTheme.secondary) }
                        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                    }
                }.padding(20)
            }.background(.black).navigationTitle(channel.title).navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { guideChannel = nil } } }
        }.preferredColorScheme(.dark)
    }
}
