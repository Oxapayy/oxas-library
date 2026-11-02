import SwiftUI

enum OxaTheme {
    static let ground = Color(white: 0.04)
    static let surface = Color(white: 0.086)
    static let raised = Color(white: 0.16)
    static let onWhite = Color(white: 0.96)
    static let secondary = Color(white: 0.71)
    static let accent = Color(red: 0.39, green: 0.72, blue: 0.88)
}
struct OxaMark: View {
    var size: CGFloat = 32
    var body: some View {
        ZStack {
            Circle().stroke(.white, lineWidth: size * 0.08)
            Image(systemName: "play.fill").font(.system(size: size * 0.31, weight: .black)).offset(x: size * 0.025)
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}
struct PressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 1), value: configuration.isPressed)
    }
}
struct PrimaryAction: View {
    var title: String
    var icon: String
    var action: () -> Void
    var body: some View {
        Button(action: action) { Label(title, systemImage: icon).font(.body.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 15).background(OxaTheme.onWhite, in: Capsule()).foregroundStyle(.black) }.buttonStyle(PressStyle())
    }
}
struct ArtView: View {
    let media: Media
    var wide = false
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                OxaTheme.surface
                if media.id.hasPrefix("preview-") {
                    Image(media.id == "preview-episode" ? "preview-series" : media.id).resizable().scaledToFill()
                } else if let url = wide ? (media.backdrop ?? media.poster) : (media.poster ?? media.backdrop), ["https", "http"].contains(url.scheme ?? "") {
                    fallback
                    SafeArtwork(url: url, sourceID: media.sourceID, pixelSize: min(1200, Int(max(geometry.size.width, geometry.size.height) * 2)))
                } else { fallback }
            }.frame(width: geometry.size.width, height: geometry.size.height).clipped()
        }.accessibilityHidden(true)
    }
    private var fallback: some View {
        VStack(alignment: .leading, spacing: 12) {
            Spacer()
            Text(media.kind == .channel ? "Live TV" : "Oxa’s Library").font(.caption).foregroundStyle(OxaTheme.secondary)
            Text(media.displayTitle).font(.system(.title2, design: .serif, weight: .medium)).lineLimit(4).foregroundStyle(.white)
            Spacer()
        }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
    }
}
struct SectionHeading: View {
    var title: String
    var count: Int? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.title3.weight(.semibold))
            Spacer()
            if let count { Text("\(count)").font(.subheadline).foregroundStyle(OxaTheme.secondary).monospacedDigit() }
        }.padding(.horizontal, 20)
    }
}
struct EmptyPanel: View {
    let title: String
    let message: String
    let icon: String
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: icon).font(.system(size: 26, weight: .light)).foregroundStyle(OxaTheme.secondary)
            Text(title).font(.title3.weight(.semibold))
            Text(message).font(.body).foregroundStyle(OxaTheme.secondary).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(24).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 20))
    }
}

extension View {
    /// Frosted pill used for the top category bar and secondary hero actions.
    func glassPill<S: Shape>(_ shape: S) -> some View {
        background(.ultraThinMaterial, in: shape).overlay(shape.stroke(.white.opacity(0.12)))
    }
}
struct CategoryBar: View {
    @Binding var selection: String
    var openLiveTV: () -> Void
    private let items = ["All", "Movies", "Series", "Watchlist"]
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(items, id: \.self) { item in
                    Button { selection = item } label: { pill(item, active: selection == item) }.accessibilityAddTraits(selection == item ? .isSelected : [])
                }
                Button(action: openLiveTV) { pill("Live TV", active: false) }
            }.padding(4)
        }.glassPill(Capsule()).clipShape(Capsule())
    }
    private func pill(_ title: String, active: Bool) -> some View {
        Text(title).font(.subheadline.weight(active ? .bold : .medium)).foregroundStyle(active ? .black : .white.opacity(0.72))
            .padding(.horizontal, 14).frame(minHeight: 40).background(active ? OxaTheme.onWhite : .clear, in: Capsule()).contentShape(Capsule())
    }
}
struct ShelfRow<Content: View>: View {
    var title: String
    var count: Int? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeading(title: title, count: count)
            ScrollView(.horizontal, showsIndicators: false) { LazyHStack(alignment: .top, spacing: 12) { content }.padding(.horizontal, 16) }
        }
    }
}
struct HeroCard: View {
    @Environment(AppStore.self) private var store
    let media: Media
    var body: some View {
        let progress = store.state.progress[media.id]
        let resuming = progress.map { !$0.completed && $0.seconds > 0 } ?? false
        let listed = media.kind == .episode ? store.catalog.first { $0.kind == .series && $0.sourceID == media.sourceID && $0.providerID == media.seriesID } ?? media : media
        let saved = store.state.favorites.contains(listed.id)
        ZStack(alignment: .bottomLeading) {
            ArtView(media: media).frame(height: 460)
            LinearGradient(colors: [.clear, .black.opacity(0.7), .black.opacity(0.94)], startPoint: UnitPoint(x: 0.5, y: 0.3), endPoint: .bottom)
            VStack(alignment: .leading, spacing: 14) {
                Text(media.displayTitle).font(.title.weight(.bold)).foregroundStyle(.white).lineLimit(2)
                Text([media.kind == .episode ? "\(media.episodeLabel) · \(media.title)" : nil, media.year.map(String.init), media.kind == .series ? "Series" : media.kind == .movie ? "Film" : nil].compactMap { $0 }.joined(separator: " · ")).font(.subheadline.weight(.medium)).foregroundStyle(.white.opacity(0.8)).lineLimit(1)
                if resuming, let progress {
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: progress.fraction).tint(OxaTheme.accent).accessibilityLabel("Watch progress")
                        Text("\(progress.seconds.clock) · \(max(0, progress.duration - progress.seconds).clock) left").font(.caption).monospacedDigit().foregroundStyle(.white.opacity(0.72))
                    }
                }
                HStack(spacing: 10) {
                    Button { Task { await store.play(media) } } label: {
                        Label(resuming ? "Resume" : "Play", systemImage: "play.fill").font(.headline).frame(maxWidth: .infinity, minHeight: 52).background(OxaTheme.onWhite, in: Capsule()).foregroundStyle(.black)
                    }.buttonStyle(PressStyle()).accessibilityIdentifier("hero-play")
                    HStack(spacing: 0) {
                        Button { store.toggleFavorite(listed) } label: { Image(systemName: saved ? "checkmark" : "plus").frame(width: 52, height: 52) }
                            .accessibilityLabel(saved ? "Remove \(listed.title) from watchlist" : "Add \(listed.title) to watchlist")
                        Rectangle().fill(.white.opacity(0.2)).frame(width: 1, height: 22)
                        NavigationLink { MediaDetailView(media: media) } label: { Image(systemName: "info.circle").frame(width: 52, height: 52) }.accessibilityLabel("Details for \(media.displayTitle)")
                    }.font(.body.weight(.semibold)).foregroundStyle(.white).glassPill(Capsule())
                }
            }.padding(20)
        }.frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 24)).overlay(RoundedRectangle(cornerRadius: 24).stroke(.white.opacity(0.12)))
    }
}
