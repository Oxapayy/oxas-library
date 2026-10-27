import SwiftUI
import ImageIO

struct SafeArtwork: View {
    @Environment(AppStore.self) private var store
    let url: URL
    var sourceID: UUID?
    var mode: ContentMode = .fill
    var pixelSize = 600
    @State private var image: UIImage?
    var body: some View {
        let source = sourceID.flatMap { store.source($0) }
        let local = source.map { URLPolicy.isLocal($0.host) } ?? false
        let request = ArtworkRequest(url: url, allowHTTP: local && source?.allowHTTP == true, publicOnly: !local, pixelSize: pixelSize)
        Group { if let image { Image(uiImage: image).resizable().aspectRatio(contentMode: mode) } else { Color.clear } }
            .task(id: request) {
                image = nil
                do {
                    let loaded = try await ArtworkRepository.shared.image(for: request)
                    try Task.checkCancellation()
                    image = loaded.image
                } catch { /* Keep the real title's fallback artwork. */ }
            }
    }
}

struct ArtworkRequest: Hashable, Sendable {
    let url: URL
    let allowHTTP: Bool
    let publicOnly: Bool
    let pixelSize: Int
}

struct ArtworkImage: @unchecked Sendable {
    let image: UIImage
    let cost: Int
}

/// A decoded, size-bounded memory cache shared by visible cards. All networking
/// and ImageIO work runs outside the main actor; at most four requests run at once.
actor ArtworkRepository {
    static let shared = ArtworkRepository()
    private let cache = NSCache<NSString, ArtworkBox>()
    private let permits = ArtworkPermits(limit: 4)
    private var requests: [ArtworkRequest: (task: Task<ArtworkImage, Error>, readers: Set<UUID>)] = [:]

    init() { cache.totalCostLimit = 40 * 1024 * 1024; cache.countLimit = 160 }

    func image(for request: ArtworkRequest) async throws -> ArtworkImage {
        let key = "\(request.allowHTTP):\(request.publicOnly):\(request.pixelSize):\(request.url.absoluteString)" as NSString
        if let cached = cache.object(forKey: key) { return cached.value }
        try Task.checkCancellation()
        let reader = UUID()
        let task: Task<ArtworkImage, Error>
        if let running = requests[request] {
            task = running.task; requests[request]?.readers.insert(reader)
        } else {
            let permits = permits
            task = Task.detached(priority: .utility) {
                try await permits.acquire()
                do {
                    try Task.checkCancellation()
                    let payload = try await BoundedHTTP.fetch(URLRequest(url: request.url), limit: 12 * 1024 * 1024, allowHTTP: request.allowHTTP, publicOnly: request.publicOnly)
                    guard (200...299).contains(payload.response.statusCode), payload.response.mimeType?.hasPrefix("image/") == true else { throw URLError(.cannotDecodeContentData) }
                    try Task.checkCancellation()
                    let image = try Self.decode(payload.data, pixelSize: request.pixelSize)
                    await permits.release()
                    return image
                } catch { await permits.release(); throw error }
            }
            requests[request] = (task, [reader])
        }
        return try await withTaskCancellationHandler {
            do {
                let result = try await task.value
                try Task.checkCancellation()
                cache.setObject(ArtworkBox(result), forKey: key, cost: result.cost)
                release(request, reader: reader)
                return result
            } catch { release(request, reader: reader); throw error }
        } onCancel: { Task { await self.release(request, reader: reader) } }
    }

    private func release(_ request: ArtworkRequest, reader: UUID) {
        guard var running = requests[request], running.readers.remove(reader) != nil else { return }
        if running.readers.isEmpty { requests.removeValue(forKey: request); running.task.cancel() }
        else { requests[request] = running }
    }

    nonisolated static func decode(_ data: Data, pixelSize: Int) throws -> ArtworkImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: max(64, min(1200, pixelSize)), kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { throw URLError(.cannotDecodeContentData) }
        return ArtworkImage(image: UIImage(cgImage: thumbnail), cost: thumbnail.bytesPerRow * thumbnail.height)
    }
}

private final class ArtworkBox {
    let value: ArtworkImage
    init(_ value: ArtworkImage) { self.value = value }
}

actor ArtworkPermits {
    private var available: Int
    private var waiters: [(UUID, CheckedContinuation<Void, Error>)] = []
    init(limit: Int) { available = limit }
    func acquire() async throws {
        try Task.checkCancellation()
        if available > 0 { available -= 1; return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { waiters.append((id, continuation)) }
            }
        } onCancel: { Task { await self.cancel(id) } }
    }
    func release() {
        if waiters.isEmpty { available += 1 }
        else { waiters.removeFirst().1.resume() }
    }
    private func cancel(_ id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.0 == id }) else { return }
        waiters.remove(at: index).1.resume(throwing: CancellationError())
    }
}
