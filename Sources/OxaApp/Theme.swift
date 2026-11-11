import SwiftUI

enum OxaTheme {
    static let ground = Color(white: 0.04)
    static let surface = Color(white: 0.086)
    static let raised = Color(white: 0.16)
    static let onWhite = Color(white: 0.96)
    static let secondary = Color(white: 0.71)
    static let accent = Color(red: 0.39, green: 0.72, blue: 0.88)

    // Radii
    static let radiusSmall: CGFloat = 8
    static let radiusCard: CGFloat = 12
    static let radiusPanel: CGFloat = 20

    /// Thin separators and outlines; stronger when Increase Contrast is on.
    static func hairline(_ contrast: ColorSchemeContrast) -> Color { .white.opacity(contrast == .increased ? 0.32 : 0.09) }

    /// Darkens artwork under text. The bottom always ends in the page ground so
    /// the hero runs into the shelves without a seam.
    static func bottomScrim(_ contrast: ColorSchemeContrast) -> LinearGradient {
        LinearGradient(stops: [
            .init(color: ground.opacity(0), location: contrast == .increased ? 0.15 : 0.3),
            .init(color: ground.opacity(contrast == .increased ? 0.9 : 0.72), location: 0.66),
            .init(color: ground, location: 1),
        ], startPoint: .top, endPoint: .bottom)
    }
    static func topScrim(_ contrast: ColorSchemeContrast) -> LinearGradient {
        LinearGradient(colors: [.black.opacity(contrast == .increased ? 0.8 : 0.55), .black.opacity(0)], startPoint: .top, endPoint: .bottom)
    }

    /// One easing curve for state changes; none at all with Reduce Motion.
    static func motion(_ reduceMotion: Bool, duration: Double = 0.24) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: duration)
    }

    /// Muted, dark tones for titles without artwork. White text stays above 7:1 on all of them.
    static let tones: [(Color, Color)] = [
        (Color(red: 0.16, green: 0.20, blue: 0.27), Color(red: 0.08, green: 0.10, blue: 0.14)),
        (Color(red: 0.12, green: 0.22, blue: 0.22), Color(red: 0.06, green: 0.11, blue: 0.11)),
        (Color(red: 0.21, green: 0.21, blue: 0.14), Color(red: 0.10, green: 0.10, blue: 0.07)),
        (Color(red: 0.22, green: 0.16, blue: 0.24), Color(red: 0.11, green: 0.08, blue: 0.12)),
        (Color(red: 0.24, green: 0.19, blue: 0.14), Color(red: 0.12, green: 0.09, blue: 0.07)),
        (Color(red: 0.17, green: 0.19, blue: 0.21), Color(red: 0.08, green: 0.09, blue: 0.10)),
        (Color(red: 0.14, green: 0.21, blue: 0.16), Color(red: 0.07, green: 0.10, blue: 0.08)),
        (Color(red: 0.16, green: 0.17, blue: 0.28), Color(red: 0.08, green: 0.08, blue: 0.14)),
    ]
    /// Stable across launches (unlike `hashValue`), so a title keeps its tone.
    static func tone(for id: String) -> (Color, Color) {
        var hash: UInt32 = 2_166_136_261
        for byte in id.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        return tones[Int(hash % UInt32(tones.count))]
    }
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
    /// Off where the screen already shows the title over the art (hero, detail).
    var titled = true
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                fallback
                if media.id.hasPrefix("preview-") {
                    Image(media.id == "preview-episode" ? "preview-series" : media.id).resizable().scaledToFill()
                } else if let url = wide ? (media.backdrop ?? media.poster) : (media.poster ?? media.backdrop), ["https", "http"].contains(url.scheme ?? "") {
                    SafeArtwork(url: url, sourceID: media.sourceID, pixelSize: min(1200, Int(max(geometry.size.width, geometry.size.height) * 2)))
                }
            }.frame(width: geometry.size.width, height: geometry.size.height).clipped()
        }.accessibilityHidden(true)
    }
    /// Shown while artwork loads and when a title has none: a tone picked from the
    /// title's identity, so the same title always looks the same.
    private var fallback: some View {
        let tone = OxaTheme.tone(for: media.seriesID.map { "\(media.sourceID):\($0)" } ?? media.id)
        return ZStack(alignment: .bottomLeading) {
            LinearGradient(colors: [tone.0, tone.1], startPoint: .topLeading, endPoint: .bottomTrailing)
            if titled { VStack(alignment: .leading, spacing: 8) {
                Text(media.kind == .channel ? "Live TV" : "Oxa’s Library").font(.caption2).foregroundStyle(.white.opacity(0.66))
                Text(media.displayTitle).font(.system(wide ? .headline : .title3, design: .serif, weight: .medium)).lineLimit(4).foregroundStyle(.white)
            }.padding(wide ? 14 : 12) }
        }
    }
}
struct SectionHeading<Accessory: View>: View {
    var title: String
    var count: Int? = nil
    var note: String? = nil
    @ViewBuilder var accessory: Accessory
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(title).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Spacer()
                accessory
                if let count { Text("\(count)").font(.subheadline).foregroundStyle(OxaTheme.secondary).monospacedDigit() }
            }
            if let note { Text(note).font(.footnote).foregroundStyle(OxaTheme.secondary) }
        }.padding(.horizontal, 20)
    }
}
extension SectionHeading where Accessory == EmptyView {
    init(title: String, count: Int? = nil, note: String? = nil) { self.init(title: title, count: count, note: note) { EmptyView() } }
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
        }.frame(maxWidth: .infinity, alignment: .leading).padding(24).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: OxaTheme.radiusPanel))
    }
}

/// Glass for chrome only (bars, pills, floating controls), never for list items.
/// iOS 26 uses the system glass; earlier systems use a thin material; Reduce
/// Transparency gets an opaque fill.
private struct GlassChrome<S: Shape>: ViewModifier {
    let shape: S
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(OxaTheme.raised, in: shape).overlay(shape.stroke(OxaTheme.hairline(contrast)))
        } else {
            #if compiler(>=6.2)
            if #available(iOS 26, *) {
                content.glassEffect(.regular, in: shape).overlay { if contrast == .increased { shape.stroke(OxaTheme.hairline(contrast)) } }
            } else { material(content) }
            #else
            material(content)
            #endif
        }
    }
    private func material(_ content: Content) -> some View {
        content.background(.ultraThinMaterial, in: shape).overlay(shape.stroke(.white.opacity(contrast == .increased ? 0.32 : 0.12)))
    }
}
extension View {
    /// Frosted pill used for the top category bar and secondary hero actions.
    func glassPill<S: Shape>(_ shape: S) -> some View { modifier(GlassChrome(shape: shape)) }
}

/// A selectable pill inside a glass bar.
struct ChipLabel: View {
    let title: String
    let active: Bool
    var body: some View {
        Text(title).font(.subheadline.weight(active ? .bold : .medium)).foregroundStyle(active ? .black : .white.opacity(0.78)).lineLimit(1)
            .padding(.horizontal, 14).frame(minHeight: 40).background(active ? OxaTheme.onWhite : .clear, in: Capsule()).contentShape(Capsule())
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
                    Button { selection = item } label: { ChipLabel(title: item, active: selection == item) }.accessibilityAddTraits(selection == item ? .isSelected : [])
                }
                Button(action: openLiveTV) { ChipLabel(title: "Live TV", active: false) }
            }.padding(4)
        }.glassPill(Capsule()).clipShape(Capsule())
    }
}
/// A horizontal shelf. Cards snap to the leading edge and the next card peeks in.
struct ShelfRow<Content: View>: View {
    var title: String
    var count: Int? = nil
    var note: String? = nil
    var spacing: CGFloat = 12
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeading(title: title, count: count, note: note)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: spacing) { content }.scrollTargetLayout()
            }.contentMargins(.horizontal, 20, for: .scrollContent).scrollTargetBehavior(.viewAligned).scrollClipDisabled()
        }
    }
}

struct HeroSlide: Identifiable {
    var media: Media
    var kicker: String?
    var id: String { media.id }
}

/// Edge-to-edge featured title under the status bar. Several slides rotate every
/// nine seconds (never with Reduce Motion or VoiceOver) and can be swiped.
struct HeroStage<Bar: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilitySwitchControlEnabled) private var switchControl
    let slides: [HeroSlide]
    var height: CGFloat
    var topInset: CGFloat
    @ViewBuilder var bar: Bar
    @State private var index = 0
    /// Any manual choice stops the rotation for this visit.
    @State private var paused = false
    var body: some View {
        let position = slides.isEmpty ? 0 : min(index, slides.count - 1)
        ZStack(alignment: .bottom) {
            if slides.indices.contains(position) {
                HeroCard(slide: slides[position], topInset: topInset, dots: slides.count > 1)
                    .id(slides[position].id).transition(.opacity)
                    .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
                        guard slides.count > 1, abs(value.translation.width) > abs(value.translation.height) * 1.5 else { return }
                        choose(position + (value.translation.width < 0 ? 1 : -1))
                    })
            }
            // Outside the card's identity, so VoiceOver focus survives a slide change.
            if slides.count > 1 { PageDots(position: position, total: slides.count, select: choose).padding(.horizontal, 20).padding(.bottom, 8) }
            VStack { bar.padding(.top, topInset + 6); Spacer(minLength: 0) }
        }
        .frame(minHeight: height).frame(maxWidth: .infinity).clipped()
        .task(id: "\(slides.map(\.id))#\(position)#\(paused)") {
            guard slides.count > 1, !paused, !reduceMotion, !voiceOver, !switchControl else { return }
            try? await Task.sleep(for: .seconds(9))
            if !Task.isCancelled { select(position + 1) }
        }
    }
    private func choose(_ next: Int) { paused = true; select(next) }
    private func select(_ next: Int) {
        guard !slides.isEmpty else { return }
        withAnimation(OxaTheme.motion(reduceMotion, duration: 0.6)) { index = (next % slides.count + slides.count) % slides.count }
    }
}

struct HeroCard: View {
    @Environment(AppStore.self) private var store
    @Environment(\.colorSchemeContrast) private var contrast
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize = 40
    let slide: HeroSlide
    var topInset: CGFloat = 0
    /// Leaves room for the page dots drawn by the stage.
    var dots = false
    var body: some View {
        let media = slide.media
        let progress = store.state.progress[media.id]
        let resuming = progress.map { !$0.completed && $0.seconds > 0 } ?? false
        let listed = media.kind == .episode ? store.catalog.first { $0.kind == .series && $0.sourceID == media.sourceID && $0.providerID == media.seriesID } ?? media : media
        let saved = store.state.favorites.contains(listed.id)
        ZStack(alignment: .bottomLeading) {
            ArtView(media: media, titled: false)
            VStack(spacing: 0) { OxaTheme.topScrim(contrast).frame(height: 150); Spacer() }
            LinearGradient(stops: [
                .init(color: OxaTheme.ground.opacity(0), location: contrast == .increased ? 0.1 : 0.22),
                .init(color: OxaTheme.ground.opacity(contrast == .increased ? 0.9 : 0.78), location: 0.5),
                .init(color: OxaTheme.ground, location: 0.86),
            ], startPoint: .top, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 12) {
                if let kicker = slide.kicker { Text(kicker).font(.subheadline.weight(.semibold)).foregroundStyle(OxaTheme.accent) }
                Text(media.displayTitle).font(.system(size: titleSize, weight: .bold)).tracking(-0.8).foregroundStyle(.white).lineLimit(2).minimumScaleFactor(0.7)
                Text([media.kind == .episode ? "\(media.episodeLabel) · \(media.title)" : nil, media.year.map(String.init), media.kind == .series ? "Series" : media.kind == .movie ? "Film" : nil].compactMap { $0 }.joined(separator: " · ")).font(.subheadline.weight(.medium)).foregroundStyle(.white.opacity(0.84)).lineLimit(1)
                if !media.overview.isEmpty, !resuming { Text(media.overview).font(.subheadline).foregroundStyle(.white.opacity(0.8)).lineLimit(2) }
                if resuming, let progress {
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: progress.fraction).tint(OxaTheme.accent).accessibilityLabel("Watch progress")
                        Text("\(progress.seconds.clock) · \(max(0, progress.duration - progress.seconds).clock) left").font(.caption).monospacedDigit().foregroundStyle(.white.opacity(0.78))
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
            }
            // Follows the text block, so large Dynamic Type sizes stay readable over bright art.
            .background(alignment: .bottom) {
                LinearGradient(stops: [.init(color: OxaTheme.ground.opacity(0), location: 0), .init(color: OxaTheme.ground.opacity(contrast == .increased ? 0.92 : 0.8), location: 0.35), .init(color: OxaTheme.ground.opacity(0.9), location: 1)], startPoint: .top, endPoint: .bottom)
                    .padding(.horizontal, -20).padding(.top, -72).padding(.bottom, dots ? -48 : -8).accessibilityHidden(true)
            }
            .padding(.horizontal, 20).padding(.top, topInset + 76).padding(.bottom, dots ? 48 : 8)
        }
    }
}

/// Page indicator for the hero. One adjustable element for VoiceOver.
struct PageDots: View {
    let position: Int
    let total: Int
    var select: (Int) -> Void
    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<total, id: \.self) { page in
                Capsule().fill(.white.opacity(page == position ? 0.95 : 0.38)).frame(width: page == position ? 18 : 6, height: 6)
                    .frame(minWidth: 22, minHeight: 32).contentShape(Rectangle()).onTapGesture { select(page) }
            }
        }.frame(maxWidth: .infinity)
            .accessibilityElement().accessibilityLabel("Featured title").accessibilityValue("\(position + 1) of \(total)")
            .accessibilityAdjustableAction { direction in
                switch direction { case .increment: select(position + 1); case .decrement: select(position - 1); @unknown default: break }
            }
    }
}
