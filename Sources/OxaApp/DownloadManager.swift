import Foundation
import AVFoundation
import Observation

@MainActor final class BackgroundEvents {
    static var completions: [String: () -> Void] = [:]
    static func finish(_ identifier: String, persist: () async throws -> Void, onError: (Error) -> Void) async {
        // The outstanding OS handler keeps a background-launched app alive.
        // Release it only after the ready/path checkpoint reaches encrypted disk.
        do { try await persist() } catch { onError(error) }
        completions.removeValue(forKey: identifier)?()
    }
}
@MainActor final class DownloadManager: NSObject, @preconcurrency URLSessionDownloadDelegate, @preconcurrency AVAssetDownloadDelegate {
    weak var store: AppStore?
    private var resolving: Set<String> = []
    private var cancelled: Set<String> = []
    private var generations: [String: UUID] = [:]
    private var tasks: [String: URLSessionTask] = [:]
    private var liveAssets: [String: AVURLAsset] = [:]
    private var progressGate = DownloadProgressGate()
    private var restored = false
    /// After a background relaunch, callbacks can arrive before restore() has
    /// listed the sessions' tasks. Adopt such a task instead of dropping its file.
    private func owns(_ task: URLSessionTask) -> String? {
        guard let id = task.taskDescription else { return nil }
        if tasks[id] === task { return id }
        guard !restored, tasks[id] == nil, store?.state.transfers.contains(where: { $0.id == id && $0.state == .downloading }) == true else { return nil }
        tasks[id] = task; return id
    }
    private lazy var files: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: "app.oxas.library.files")
        config.allowsCellularAccess = true; config.isDiscretionary = false
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()
    private lazy var streams: AVAssetDownloadURLSession = streamSession("app.oxas.library.hls", cellular: true)
    // Asset tasks can't opt out of cellular one by one, so Wi-Fi-only HLS
    // downloads use their own background session.
    private lazy var wifiStreams: AVAssetDownloadURLSession = streamSession("app.oxas.library.hls.wifi", cellular: false)
    private func streamSession(_ identifier: String, cellular: Bool) -> AVAssetDownloadURLSession {
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.allowsCellularAccess = cellular; config.isDiscretionary = false
        return AVAssetDownloadURLSession(configuration: config, assetDownloadDelegate: self, delegateQueue: .main)
    }
    init(store: AppStore) {
        self.store = store; super.init()
        Task { await restore() }
    }
    private func restore() async {
        guard store?.preview != true else { return }
        let context = store?.libraryEpoch
        let runningFiles = await files.allTasks; let runningStreams = await streams.allTasks + wifiStreams.allTasks
        restored = true
        guard context == store?.libraryEpoch else { return }
        for task in runningFiles + runningStreams { if let id = task.taskDescription { tasks[id] = task; if task.state == .suspended { task.resume() } } }
        guard let store else { return }
        for index in store.state.transfers.indices {
            let transfer = store.state.transfers[index]
            if transfer.state == .downloading && tasks[transfer.id] == nil { store.state.transfers[index].state = .failed; store.state.transfers[index].error = "This download was interrupted. Tap Retry." }
            if transfer.state == .ready && store.localURL(transfer.media) == nil { store.state.transfers[index].state = .failed; store.state.transfers[index].error = "The saved file is missing. Download it again." }
        }
        store.save(); pump()
    }
    func stopForAccountChange() async {
        let known = Array(tasks.values); tasks.removeAll(); liveAssets.removeAll()
        for task in known { task.cancel() }
        for task in await files.allTasks { task.cancel() }
        for task in await streams.allTasks + wifiStreams.allTasks { task.cancel() }
        resolving.removeAll(); generations.removeAll(); cancelled.removeAll()
    }
    func enqueuePrepared(_ media: Media) { enqueue(media) }
    func enqueue(_ media: Media) {
        enqueueBatch([media])
    }
    func enqueueBatch(_ items: [Media]) {
        guard let store, !store.preview else { return }
        var transfers = store.state.transfers
        var indexes = Dictionary(transfers.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
        for media in items where media.kind == .movie || media.kind == .episode {
            if let index = indexes[media.id] {
                guard ![.ready, .downloading, .queued].contains(transfers[index].state) else { continue }
                transfers[index] = Transfer(id: media.id, media: media)
            } else { indexes[media.id] = transfers.count; transfers.append(Transfer(id: media.id, media: media)) }
            generations[media.id] = UUID(); cancelled.remove(media.id)
        }
        store.state.transfers = transfers; store.save(); pump()
    }
    private func pump() {
        guard let store else { return }
        let count = tasks.count + resolving.count
        for transfer in store.state.transfers.filter({ $0.state == .queued && !resolving.contains($0.id) && tasks[$0.id] == nil }).prefix(max(0, 2 - count)) {
            resolving.insert(transfer.id); update(transfer.id) { $0.state = .downloading; $0.error = nil }
            let generation = generations[transfer.id]
            Task { await start(transfer, generation: generation) }
        }
    }
    private func start(_ transfer: Transfer, generation: UUID?) async {
        defer { resolving.remove(transfer.id); pump() }
        guard let store else { return }
        let context = store.libraryEpoch
        do {
            let api = try store.api(transfer.media.sourceID)
            var prepared = transfer.media
            if let preference = transfer.media.downloadPreference, transfer.media.websiteItem != nil, transfer.media.websiteResolved != true {
                let library = WebsiteLibrary(source: api.source, endpoint: api.base)
                let connection = try await library.discover()
                let (detailed, choices) = try await library.sources(transfer.media, connection: connection)
                guard let selected = choices.first(where: { $0.name == preference.name && $0.languages == preference.languages && $0.quality == preference.quality && $0.url.host == preference.url.host }) else { throw OxaError.message("The selected server is unavailable for this episode. Choose another source.") }
                prepared = try await library.playable(detailed, connection: connection, subtitleLanguage: store.state.preferences.subtitleLanguage, selected: selected)
                prepared.downloadPreference = preference
            } else if transfer.media.websiteResolved != true { prepared = try await api.preparePlayback(transfer.media, subtitleLanguage: store.state.preferences.subtitleLanguage) }
            let url = try await api.playbackURL(prepared, download: true)
            guard store.libraryEpoch == context else { return }
            if cancelled.contains(transfer.id) || generations[transfer.id] != generation { return }
            _ = try URLPolicy.validateStream(url.absoluteString, source: api.source)
            update(transfer.id) { $0.media = prepared }
            var isHLS = url.pathExtension.lowercased() == "m3u8" || prepared.streamFormat == "hls"
            if !isHLS && url.pathExtension.isEmpty {
                var probe = URLRequest(url: url); probe.httpMethod = "HEAD"
                for (name, value) in prepared.playbackHeaders ?? [:] { probe.setValue(value, forHTTPHeaderField: name) }
                let head = try await BoundedHTTP.fetch(probe, limit: 1024, allowHTTP: api.source.allowHTTP, crossOrigin: true, allowPublicHTTP: api.source.allowInsecureStreams == true)
                isHLS = head.response.mimeType?.lowercased().contains("mpegurl") == true
            }
            if isHLS {
                let asset = AVURLAsset(url: url, options: prepared.playbackHeaders.map { ["AVURLAssetHTTPHeaderFieldsKey": $0] })
                liveAssets[transfer.id] = asset
                let session = store.state.preferences.cellular ? streams : wifiStreams
                guard let task = session.makeAssetDownloadTask(asset: asset, assetTitle: transfer.media.title, assetArtworkData: nil, options: nil) else { throw OxaError.message("This stream cannot be saved offline.") }
                task.taskDescription = transfer.id; tasks[transfer.id] = task; task.resume()
            } else {
                var request = URLRequest(url: url)
                request.allowsCellularAccess = store.state.preferences.cellular
                if URLPolicy.sameOrigin(api.base, url) { for (key, value) in api.authHeaders { request.setValue(value, forHTTPHeaderField: key) } }
                for (key, value) in prepared.playbackHeaders ?? [:] { request.setValue(value, forHTTPHeaderField: key) }
                let task = files.downloadTask(with: request); task.taskDescription = transfer.id; tasks[transfer.id] = task; task.resume()
            }
        } catch { if store.libraryEpoch == context { fail(transfer.id, store.safeMessage(error)) } }
    }
    func cancel(_ id: String) {
        progressGate.remove(id)
        generations[id] = UUID(); cancelled.insert(id); tasks.removeValue(forKey: id)?.cancel(); liveAssets.removeValue(forKey: id)
        update(id) { $0.state = .cancelled; $0.error = nil }; pump()
    }
    func delete(_ id: String) {
        guard let store, let transfer = store.state.transfers.first(where: { $0.id == id }) else { return }
        cancel(id)
        do {
            if let path = transfer.relativePath, let root = store.disk?.mediaRoot, let url = URLPolicy.relativeFile(path, root: root), FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            if let path = transfer.systemRelativePath, path.hasPrefix("Library/"), let url = URLPolicy.relativeFile(path, root: URL(fileURLWithPath: NSHomeDirectory())), FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            store.state.transfers.removeAll { $0.id == id }; store.save()
        } catch { store.error = "The saved file could not be deleted. Try again." }
    }
    private func update(_ id: String, persist: Bool = true, _ mutation: (inout Transfer) -> Void) {
        guard let store, let index = store.state.transfers.firstIndex(where: { $0.id == id }) else { return }
        mutation(&store.state.transfers[index])
        if persist { store.save() }
    }
    private func fail(_ id: String, _ message: String) {
        if cancelled.contains(id) { return }; update(id) { $0.state = .failed; $0.error = message }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = owns(downloadTask), !cancelled.contains(id) else { return }
        guard progressGate.shouldPublish(id, at: ProcessInfo.processInfo.systemUptime) else { return }
        // Persist queue/terminal states and the background snapshot. Transient
        // byte counters do not need to re-encode the complete catalog.
        update(id, persist: false) { $0.bytes = totalBytesWritten; $0.fraction = totalBytesExpectedToWrite > 0 ? min(0.99, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)) : 0 }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = owns(downloadTask), !cancelled.contains(id), let root = store?.disk?.mediaRoot else { return }
        guard let response = downloadTask.response as? HTTPURLResponse, (200...299).contains(response.statusCode) else { fail(id, "The server rejected this download. Check download permissions and retry."); return }
        if let mime = response.mimeType, mime.contains("text/html") || mime.contains("application/json") { fail(id, "The server returned a page instead of a video file."); return }
        let ext = downloadTask.originalRequest?.url?.pathExtension.lowercased() ?? ""
        let filename = UUID().uuidString + "." + (["mp4", "m4v", "mov", "mkv", "ts"].contains(ext) ? ext : "mp4")
        do {
            let target = root.appendingPathComponent(filename)
            try FileManager.default.moveItem(at: location, to: target)
            let size = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            update(id) { $0.state = .ready; $0.relativePath = filename; $0.fraction = 1; $0.bytes = Int64(size); $0.error = nil }
        } catch { fail(id, "Could not save the video. Check free storage and retry.") }
    }
    func urlSession(_ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didLoad timeRange: CMTimeRange, totalTimeRangesLoaded loadedTimeRanges: [NSValue], timeRangeExpectedToLoad: CMTimeRange) {
        guard let id = owns(assetDownloadTask) else { return }
        guard progressGate.shouldPublish(id, at: ProcessInfo.processInfo.systemUptime) else { return }
        let expected = timeRangeExpectedToLoad.duration.seconds
        let actual = loadedTimeRanges.reduce(0.0) { $0 + $1.timeRangeValue.duration.seconds }
        update(id, persist: false) { $0.fraction = expected.isFinite && expected > 0 ? min(0.99, actual / expected) : 0 }
    }
    func urlSession(_ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = owns(assetDownloadTask), !cancelled.contains(id), let root = store?.disk?.mediaRoot else { return }
        _ = root
        let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.path + "/"
        guard location.standardizedFileURL.path.hasPrefix(home) else { fail(id, "The offline stream location could not be saved."); return }
        let path = String(location.standardizedFileURL.path.dropFirst(home.count))
        guard path.hasPrefix("Library/") else { fail(id, "The offline stream has an unexpected storage location."); return }
        // AVFoundation owns this package. Never move it; only persist a sandbox-relative reference.
        update(id) { $0.systemRelativePath = path; $0.fraction = 0.99; $0.error = nil }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = owns(task) else { return }
        progressGate.remove(id)
        tasks.removeValue(forKey: id); liveAssets.removeValue(forKey: id)
        if let error, !cancelled.contains(id) { fail(id, store?.safeMessage(error) ?? "Download failed. Try again.") }
        else if task is AVAssetDownloadTask, !cancelled.contains(id) {
            if let transfer = store?.state.transfers.first(where: { $0.id == id }), transfer.systemRelativePath != nil {
                update(id) { $0.state = .ready; $0.fraction = 1; $0.error = nil }
            } else { fail(id, "The offline stream did not finish saving. Please retry.") }
        }
        if !cancelled.contains(id) { Task { await saveCaption(for: id) } }
        pump()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let old = (task as? AVAssetDownloadTask)?.urlAsset.url ?? task.originalRequest?.url, let target = request.url,
              let id = task.taskDescription, let transfer = store?.state.transfers.first(where: { $0.id == id }), let source = store?.source(transfer.media.sourceID),
              (task.countOfBytesReceived == 0), (try? URLPolicy.validateStream(target.absoluteString, source: source)) != nil else { completionHandler(nil); return }
        var safe = request
        if !URLPolicy.sameOrigin(old, target) {
            guard let host = target.host, !URLPolicy.isLocal(host) else { completionHandler(nil); return }
            for name in ["Authorization", "Cookie", "X-Emby-Authorization", "X-Plex-Token", "Referer", "Origin"] { safe.setValue(nil, forHTTPHeaderField: name) }
        }
        completionHandler(safe)
    }
    private func saveCaption(for id: String) async {
        let context = store?.libraryEpoch
        guard let store, let transfer = store.state.transfers.first(where: { $0.id == id && $0.state == .ready }), transfer.media.subtitlePath == nil,
              store.state.preferences.subtitleLanguage != "off", let root = store.disk?.mediaRoot,
              let api = try? store.api(transfer.media.sourceID), let url = try? await api.captionURL(transfer.media, language: store.state.preferences.subtitleLanguage),
              let data = try? await HTTPClient.shared.data(url, source: api.source), let text = String(data: data, encoding: .utf8), !CaptionParser.parse(text).isEmpty else { return }
        guard context == store.libraryEpoch else { return }
        do {
            let filename = UUID().uuidString + ".vtt"; try data.write(to: root.appendingPathComponent(filename), options: .atomic)
            update(id) { $0.media.subtitlePath = filename }
        } catch { /* The video remains usable; captions can be imported manually. */ }
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let id = session.configuration.identifier else { return }
        Task { @MainActor [weak store] in
            await BackgroundEvents.finish(id, persist: {
                guard let store else { return }
                try await store.persistSnapshot()
            }, onError: { error in
                store?.error = "Could not save the completed download. Check free storage and keep the app open to retry. \(error.localizedDescription)"
            })
        }
    }
}

/// Network callbacks can arrive hundreds of times per second. Publish progress
/// at most four times a second; terminal states always bypass this gate.
struct DownloadProgressGate {
    private var lastPublished: [String: TimeInterval] = [:]
    mutating func shouldPublish(_ id: String, at time: TimeInterval) -> Bool {
        if let last = lastPublished[id], time - last < 0.25 { return false }
        lastPublished[id] = time; return true
    }
    mutating func remove(_ id: String) { lastPublished.removeValue(forKey: id) }
}
