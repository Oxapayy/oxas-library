import SwiftUI
import ImageIO

struct SafeArtwork: View {
    @Environment(AppStore.self) private var store
    let url: URL
    var sourceID: UUID?
    var mode: ContentMode = .fill
    @State private var image: UIImage?
    var body: some View {
        Group { if let image { Image(uiImage: image).resizable().aspectRatio(contentMode: mode) } else { Color.clear } }
            .task(id: url) {
                image = nil
                do {
                    let source = sourceID.flatMap { store.source($0) }
                    let local = source.map { URLPolicy.isLocal($0.host) } ?? false
                    let payload = try await BoundedHTTP.fetch(URLRequest(url: url), limit: 12 * 1024 * 1024, allowHTTP: local && source?.allowHTTP == true, publicOnly: !local)
                    guard (200...299).contains(payload.response.statusCode), payload.response.mimeType?.hasPrefix("image/") == true else { return }
                    try Task.checkCancellation()
                    let imageSource = CGImageSourceCreateWithData(payload.data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
                    if let imageSource, let thumbnail = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1600, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) { image = UIImage(cgImage: thumbnail) }
                } catch { /* Keep the real title's fallback artwork. */ }
            }
    }
}
