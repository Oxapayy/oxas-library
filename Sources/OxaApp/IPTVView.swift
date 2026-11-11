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
                    EmptyPanel(title: "No live channels yet", message: "Add an M3U playlist or Xtream Codes login to see your channels and their program guide here.", icon: "tv").padding(.horizontal, 20)
                    PrimaryAction(title: "Add IPTV Source", icon: "plus") { store.showAddSource = true }.padding(.horizontal, 20)
                } else {
                    if query.isEmpty {
                        // Only channels in the selected group; capped so 400 channels stay cheap.
                        let airing = Array(Shelves.onNow(selectedGroup == nil ? channels : channels.filter { $0.group == selectedGroup }, guide: { store.guide($0) }, favorites: store.state.favorites).prefix(20))
                        if !airing.isEmpty { ShelfRow(title: "On Now") { ForEach(airing) { item in nowCard(item) } } }
                    }
                    if !groups.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 2) {
                                groupChip("All", active: selectedGroup == nil) { selectedGroup = nil }
                                ForEach(groups, id: \.self) { group in groupChip(group, active: selectedGroup == group) { selectedGroup = group } }
                            }.padding(4)
                        }.glassPill(Capsule()).clipShape(Capsule()).padding(.horizontal, 20)
                    }
                    HStack {
                        Button { favoritesOnly.toggle() } label: { Label(favoritesOnly ? "Favorites" : "All channels", systemImage: favoritesOnly ? "star.fill" : "star").font(.subheadline).frame(minHeight: 44) }
                        Spacer()
                        Text("\(visible.count) channels").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                    }.padding(.horizontal, 20)
                    Group {
                        if visible.isEmpty { Text("No channels match this search or filter.").foregroundStyle(OxaTheme.secondary) }
                        LazyVStack(spacing: 12) { ForEach(visible) { channel in channelRow(channel) } }
                        ForEach((store.state.websitePages ?? []).filter { $0.catalog.type == "live" && $0.cursor != nil }) { page in
                            Button { Task { await store.loadWebsitePage(page) } } label: { Label("Load More Channels", systemImage: "arrow.down").frame(minHeight: 44) }.disabled(store.loadingWebsitePages.contains(page.id))
                        }
                        ForEach(store.sources.filter { ($0.kind.isTV || $0.kind == .website) && store.notices[$0.id] != nil }) { source in Text(store.notices[source.id] ?? "").font(.subheadline).foregroundStyle(OxaTheme.secondary) }
                    }.padding(.horizontal, 20)
                }
            }.padding(.vertical, 20)
        }.background(OxaTheme.ground).navigationTitle("Live TV").navigationBarTitleDisplayMode(.inline)
            .modifier(ChannelSearch(query: $query, enabled: !channels.isEmpty))
            .toolbar { if !channels.isEmpty { ToolbarItem(placement: .topBarTrailing) { Button { store.showAddSource = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add IPTV source") } } }
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
                        VStack(alignment: .leading, spacing: 5) { Text(channel.title).font(.body.weight(.semibold)); if let detail = now?.title ?? channel.group { Text(detail).font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(2) } }
                        Spacer(minLength: 0)
                        Image(systemName: "play.fill").font(.subheadline)
                    }
                }.buttonStyle(PressStyle()).accessibilityIdentifier("play-channel-\(channel.providerID)")
                Button { store.toggleFavorite(channel) } label: { Image(systemName: store.state.favorites.contains(channel.id) ? "star.fill" : "star").frame(width: 44, height: 44) }.accessibilityLabel(store.state.favorites.contains(channel.id) ? "Remove \(channel.title) from favorites" : "Favorite \(channel.title)")
            }
            if let now {
                let fraction = min(1, max(0, Date.now.timeIntervalSince(now.start) / now.end.timeIntervalSince(now.start)))
                ProgressLine(fraction: fraction)
                HStack { Text(now.start, style: .time); Spacer(); Text(now.end, style: .time) }.font(.caption).foregroundStyle(OxaTheme.secondary)
            }
            Button { guideChannel = channel } label: { Label("Program Guide", systemImage: "list.bullet").font(.subheadline).frame(minHeight: 44) }
        }.padding(16).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: OxaTheme.radiusCard))
    }
    private func groupChip(_ title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { ChipLabel(title: title, active: active) }.buttonStyle(PressStyle()).accessibilityAddTraits(active ? .isSelected : [])
    }
    private func nowCard(_ item: Shelves.Airing) -> some View {
        let channel = item.channel, program = item.program
        let span = program.end.timeIntervalSince(program.start)
        let fraction = span > 0 ? min(1, max(0, Date.now.timeIntervalSince(program.start) / span)) : 0
        let favorite = store.state.favorites.contains(channel.id)
        return Button { Task { await store.play(channel) } } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    if let poster = channel.poster { SafeArtwork(url: poster, sourceID: channel.sourceID, mode: .fit, pixelSize: 132).frame(width: 40, height: 40) }
                    else { Image(systemName: "tv").font(.title3).frame(width: 40, height: 40).foregroundStyle(OxaTheme.secondary) }
                    Text(channel.title).font(.subheadline.weight(.semibold)).foregroundStyle(OxaTheme.secondary).lineLimit(1)
                }
                Text(program.title).font(.headline).foregroundStyle(.white).lineLimit(2).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 0)
                ProgressLine(fraction: fraction)
                if let next = item.next { (Text("Next · ") + Text(next.start, style: .time) + Text(" \(next.title)")).font(.caption).foregroundStyle(OxaTheme.secondary).lineLimit(1) }
            }.padding(14).frame(width: 260, alignment: .leading).frame(minHeight: 150).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: OxaTheme.radiusCard)).contentShape(RoundedRectangle(cornerRadius: OxaTheme.radiusCard))
        }.buttonStyle(PressStyle())
            .accessibilityElement(children: .combine).accessibilityLabel("\(channel.title), now: \(program.title)").accessibilityIdentifier("now-channel-\(channel.providerID)")
            .contextMenu {
                Button { Task { await store.play(channel) } } label: { Label("Watch Live", systemImage: "play.fill") }
                Button { store.toggleFavorite(channel) } label: { Label(favorite ? "Remove from Favorites" : "Add to Favorites", systemImage: favorite ? "star.slash" : "star") }
            }
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
            }.background(OxaTheme.ground).navigationTitle(channel.title).navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { guideChannel = nil } } }
        }.preferredColorScheme(.dark)
    }
}

private struct ChannelSearch: ViewModifier {
    @Binding var query: String
    let enabled: Bool
    func body(content: Content) -> some View {
        if enabled { content.searchable(text: $query, prompt: "Channels and programs") } else { content }
    }
}
