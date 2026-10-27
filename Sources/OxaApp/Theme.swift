import SwiftUI

enum OxaTheme {
    static let ground = Color.black
    static let surface = Color(white: 0.067)
    static let raised = Color(white: 0.16)
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
        Button(action: action) { Label(title, systemImage: icon).font(.body.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 15).background(.white, in: Capsule()).foregroundStyle(.black) }.buttonStyle(PressStyle())
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
                } else if let url = wide ? (media.backdrop ?? media.poster) : media.poster, ["https", "http"].contains(url.scheme ?? "") {
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
