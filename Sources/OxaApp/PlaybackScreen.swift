import SwiftUI
import AVKit
import Observation

@MainActor @Observable final class PlayerSession {
    let player = AVPlayer()
    var current: Media
    var failure: String?
    var subtitle = ""
    var externalCaptions = true
    var captionCues: [CaptionCue] = []
    var hasCaptions = false
    var completed = false
    var seconds: Double = 0
    var duration: Double = 0
    var isPlaying = false
    var countdown: Int?
    var nextCancelled = false
    var switchingEpisode = false
    var audioOptions: [AVMediaSelectionOption] = []
    var subtitleOptions: [AVMediaSelectionOption] = []
    var audioGroup: AVMediaSelectionGroup?
    var subtitleGroup: AVMediaSelectionGroup?
    var pip: AVPictureInPictureController?
    private var countdownTask: Task<Void, Never>?
    var hasNextEpisode: Bool { store?.nextEpisode(current) != nil }
    weak var store: AppStore?
    private var observer: Any?
    private var statusObserver: NSKeyValueObservation?
    private var controlObserver: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var stallObserver: NSObjectProtocol?
    private var loadEpoch = UUID()
    private var closed = false
    private var lastSaved: Double = -10
    private var setupTask: Task<Void, Never>?
    init(playback: Playback, store: AppStore) {
        current = playback.media; self.store = store
        setupTask = Task { await load(playback.media, url: playback.url) }
    }
    func load(_ media: Media, url: URL) async {
        guard !closed else { return }; let token = UUID(); loadEpoch = token
        countdownTask?.cancel(); countdown = nil; nextCancelled = false; seconds = 0; duration = 0; audioOptions = []; subtitleOptions = []; audioGroup = nil; subtitleGroup = nil
        stopObserving(); externalCaptions = store?.state.preferences.subtitleLanguage != "off"; current = media; subtitle = ""; captionCues = []; failure = nil; completed = false; hasCaptions = false; lastSaved = -10
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
            var options: [String: Any] = [:]
            if !url.isFileURL, let api = try? store?.api(media.sourceID), URLPolicy.sameOrigin(api.base, url), api.source.kind == .webdav {
                options["AVURLAssetHTTPHeaderFieldsKey"] = api.authHeaders
            }
            if !url.isFileURL, let headers = media.playbackHeaders, !headers.isEmpty { options["AVURLAssetHTTPHeaderFieldsKey"] = headers }
            let asset = AVURLAsset(url: url, options: options)
            let item = AVPlayerItem(asset: asset)
            player.replaceCurrentItem(with: item)
            controlObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
                Task { @MainActor in self?.isPlaying = player.timeControlStatus == .playing; if player.timeControlStatus == .paused { self?.save() } }
            }
            statusObserver = item.observe(\.status, options: [.new]) { [weak self] item, _ in
                if item.status == .failed { Task { @MainActor in self?.failure = self?.current.websiteItem == nil ? "This video could not be played. Check the connection and your server’s compatible playback formats." : "This server’s stream could not be played. Try another server or retry with a fresh stream." } }
            }
            observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
                Task { @MainActor in self?.tick(time.seconds) }
            }
            endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in Task { @MainActor in await self?.ended() } }
            stallObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in Task { @MainActor in self?.failure = "Playback was interrupted. Check your connection and tap Retry." } }
            if let saved = store?.state.progress[media.id], !saved.completed, saved.seconds > 0, media.kind != .channel {
                await player.seek(to: CMTime(seconds: saved.seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            }
            // Start immediately; track/subtitle discovery must not delay playback.
            guard token == loadEpoch, !closed, !Task.isCancelled else { return }
            player.play()
            if let store {
                if let group = try? await asset.loadMediaSelectionGroup(for: .audible) {
                    audioGroup = group; audioOptions = group.options
                    let options = AVMediaSelectionGroup.mediaSelectionOptions(from: group.options, with: Locale(identifier: store.state.preferences.audioLanguage))
                    guard token == loadEpoch, !closed else { return }
                    if let option = options.first { item.select(option, in: group) }
                }
                if let group = try? await asset.loadMediaSelectionGroup(for: .legible) {
                    subtitleGroup = group; subtitleOptions = group.options
                    if store.state.preferences.subtitleLanguage == "off" { item.select(nil, in: group) }
                    else {
                        let options = AVMediaSelectionGroup.mediaSelectionOptions(from: group.options, with: Locale(identifier: store.state.preferences.subtitleLanguage))
                        guard token == loadEpoch, !closed else { return }
                    if let option = options.first { item.select(option, in: group) }
                    }
                }
                if let path = media.subtitlePath, let root = store.disk?.mediaRoot, let local = URLPolicy.relativeFile(path, root: root), let text = try? String(contentsOf: local, encoding: .utf8) {
                    captionCues = CaptionParser.parse(text)
                } else if !url.isFileURL, store.state.preferences.subtitleLanguage != "off", let api = try? store.api(media.sourceID),
                          let captionURL = try? await api.captionURL(media, language: store.state.preferences.subtitleLanguage),
                          let data = try? await HTTPClient.shared.data(captionURL, source: api.source), let text = String(data: data, encoding: .utf8) {
                    captionCues = CaptionParser.parse(text)
                }
                guard token == loadEpoch, !closed else { return }
                hasCaptions = !captionCues.isEmpty
                if hasCaptions, let group = try? await asset.loadMediaSelectionGroup(for: .legible) { item.select(nil, in: group) }
            }
        } catch { failure = "The player could not start. Close it and try this title again." }
    }
    func tick(_ seconds: Double) {
        guard seconds.isFinite else { return }
        self.seconds = seconds
        let actual = player.currentItem?.duration.seconds ?? current.duration
        duration = actual.isFinite && actual > 0 ? actual : current.duration
        isPlaying = player.timeControlStatus == .playing
        if current.kind == .episode, store?.state.preferences.autoplay == true, hasNextEpisode, !nextCancelled, countdown == nil, PlaybackPolicy.nextEpisodePrompt(at: seconds, duration: duration, creditsStart: current.creditsStart) { beginCountdown() }
        if !PlaybackPolicy.nextEpisodePrompt(at: seconds, duration: duration, creditsStart: current.creditsStart), countdown != nil { cancelCountdown(permanently: false) }
        let at = seconds + current.subtitleDelay
        subtitle = externalCaptions ? captionCues.first { $0.start <= at && $0.end > at }?.text ?? "" : ""
        if abs(seconds - lastSaved) >= 5 { save(); lastSaved = seconds }
    }
    func save() {
        let seconds = player.currentTime().seconds
        guard player.currentItem != nil, seconds.isFinite, !completed else { return }
        store?.record(current, seconds: seconds, duration: player.currentItem?.duration.seconds ?? current.duration)
    }
    func skip(_ seconds: Double) {
        let current = player.currentTime().seconds
        guard current.isFinite else { return }
        let duration = player.currentItem?.duration.seconds ?? .infinity
        player.seek(to: CMTime(seconds: min(duration.isFinite ? duration : .infinity, max(0, current + seconds)), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }
    private func ended() async {
        guard let store else { return }
        let duration = player.currentItem?.duration.seconds ?? current.duration
        store.record(current, seconds: duration.isFinite ? duration : player.currentTime().seconds, duration: duration, ended: true); completed = true
        guard store.state.preferences.autoplay, !nextCancelled else { return }
        await findNextSeason()
        if hasNextEpisode { beginCountdown() }
    }
    private func findNextSeason() async {
        guard let store else { return }
        if store.nextEpisode(current) == nil, current.websiteItem != nil, let parentID = current.seriesID,
           let series = store.catalog.first(where: { $0.sourceID == current.sourceID && $0.providerID == parentID && $0.kind == .series }),
           let season = series.websiteItem?.seasons.filter({ $0.number > (current.season ?? 0) }).min(by: { $0.number < $1.number }) {
            await store.loadWebsiteSeason(series, number: season.number)
        }
    }
    func beginCountdown() {
        guard countdown == nil, !nextCancelled, !switchingEpisode else { return }
        countdown = 5
        let token = loadEpoch
        countdownTask = Task {
            while !Task.isCancelled, token == loadEpoch, !closed, let value = countdown, value > 0 {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, token == loadEpoch, !closed else { return }
                if player.timeControlStatus == .playing || completed { countdown = value - 1 }
            }
            guard !Task.isCancelled, token == loadEpoch, !closed, countdown == 0 else { return }
            await playNext()
        }
    }
    func cancelCountdown(permanently: Bool = true) { countdownTask?.cancel(); countdown = nil; if permanently { nextCancelled = true } }
    func seek(to value: Double) { guard value.isFinite else { return }; player.seek(to: CMTime(seconds: min(max(0, value), duration), preferredTimescale: 600)) }
    func togglePlayback() { if player.timeControlStatus == .playing { player.pause() } else { player.play() } }
    func playNext() async {
        guard let store, !closed, !switchingEpisode else { return }
        switchingEpisode = true; defer { switchingEpisode = false }
        save()
        if countdown == 0 { store.record(current, seconds: duration, duration: duration, ended: true) }
        countdown = nil
        await findNextSeason()
        guard !closed, let next = store.nextEpisode(current) else { return }
        do {
            let url: URL
            var prepared = next
            if let local = store.localURL(next) { url = local }
            else {
                let api = try store.api(next.sourceID)
                if next.websiteItem != nil {
                    let client = WebsiteLibrary(source: api.source, endpoint: api.base), connection = try await clientConnection(api)
                    let (detailed, choices) = try await client.sources(next, connection: connection)
                    guard !closed else { return }
                    guard let previous = store.playback?.selectedSource, let choice = choices.first(where: { $0.name == previous.name && $0.languages == previous.languages && $0.quality == previous.quality && $0.url.host == previous.url.host }) else { try await store.requestSources(next); return }
                    prepared = try await client.playable(detailed, connection: connection, subtitleLanguage: store.state.preferences.subtitleLanguage, selected: choice)
                    guard let stream = prepared.stream else { return }; url = stream
                    guard !closed else { return }
                    if let active = store.playback { store.playback = Playback(id: active.id, selectedSource: choice, media: prepared, url: url); return }
                } else { prepared = try await api.preparePlayback(next, subtitleLanguage: store.state.preferences.subtitleLanguage); url = try await api.playbackURL(prepared) }
            }
            if let active = store.playback { store.playback = Playback(id: active.id, media: prepared, url: url) } else { await load(prepared, url: url) }
        }
        catch { failure = "The next episode could not be loaded. Your progress has been saved." }
    }
    private func stopObserving() {
        if let observer { player.removeTimeObserver(observer); self.observer = nil }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver); self.endObserver = nil }
        if let stallObserver { NotificationCenter.default.removeObserver(stallObserver); self.stallObserver = nil }
        statusObserver = nil; controlObserver = nil
    }
    private func clientConnection(_ api: MediaAPI) async throws -> WebsiteConnection { try await WebsiteLibrary(source: api.source, endpoint: api.base).discover() }
    func close() { countdownTask?.cancel(); pip?.stopPictureInPicture(); closed = true; loadEpoch = UUID(); setupTask?.cancel(); save(); player.pause(); stopObserving(); player.replaceCurrentItem(with: nil) }
}
final class VideoSurface: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var videoLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
struct NativePlayer: UIViewRepresentable {
    let session: PlayerSession
    let fill: Bool
    func makeUIView(context: Context) -> VideoSurface {
        let surface = VideoSurface(); surface.backgroundColor = .black; surface.videoLayer.player = session.player
        if AVPictureInPictureController.isPictureInPictureSupported() {
            let pip = AVPictureInPictureController(playerLayer: surface.videoLayer)
            pip?.canStartPictureInPictureAutomaticallyFromInline = true; session.pip = pip
        }
        return surface
    }
    func updateUIView(_ surface: VideoSurface, context: Context) {
        surface.videoLayer.player = session.player; surface.videoLayer.videoGravity = fill ? .resizeAspectFill : .resizeAspect
    }
}
struct PlaybackScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let playback: Playback
    @State private var session: PlayerSession?
    @State private var retrying = false
    @State private var retryTask: Task<Void, Never>?
    @State private var fill = false
    @State private var controls = true
    @State private var resumeAfterSource = false
    var body: some View {
        GeometryReader { geometry in
            if let session {
                ZStack {
                    Color.black
                    NativePlayer(session: session, fill: fill).ignoresSafeArea().onTapGesture { withAnimation(.easeOut(duration: 0.15)) { controls.toggle() } }.accessibilityIdentifier("video-surface")
                    if controls {
                        VStack(spacing: 12) {
                            HStack(spacing: 12) {
                                Button { session.close(); dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("Close player")
                                VStack(alignment: .leading, spacing: 3) { Text(session.current.displayTitle).font(.headline).lineLimit(1); if session.current.kind == .episode { Text("\(session.current.episodeLabel) · \(session.current.title)").font(.caption).lineLimit(1) } }
                                Spacer(minLength: 0)
                                AirPlayRoute().frame(width: 44, height: 44).accessibilityLabel("AirPlay")
                                Button { fill.toggle() } label: { Image(systemName: fill ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44) }.accessibilityLabel(fill ? "Fit video" : "Fill screen")
                            }.padding(.horizontal, 8).background(.black.opacity(0.65))
                            Spacer(minLength: 0)
                            if session.failure == nil {
                                HStack(spacing: 36) {
                                    Button { session.skip(-10) } label: { Image(systemName: "gobackward.10").font(.title).frame(width: 48, height: 48) }.accessibilityLabel("Back 10 seconds")
                                    Button { session.togglePlayback() } label: { Image(systemName: session.isPlaying ? "pause.fill" : "play.fill").font(.largeTitle).frame(width: 64, height: 64).background(.black.opacity(0.55), in: Circle()) }.accessibilityLabel(session.isPlaying ? "Pause" : "Play video")
                                    Button { session.skip(10) } label: { Image(systemName: "goforward.10").font(.title).frame(width: 48, height: 48) }.accessibilityLabel("Forward 10 seconds")
                                }
                            }
                            Spacer(minLength: 0)
                            VStack(spacing: 6) {
                                if session.current.kind != .channel {
                                    Slider(value: Binding(get: { min(session.seconds, max(1, session.duration)) }, set: { session.seek(to: $0) }), in: 0...max(1, session.duration)).tint(.white).accessibilityLabel("Playback position")
                                    HStack { Text(session.seconds.clock); Spacer(); Text("−" + max(0, session.duration - session.seconds).clock) }.font(.caption).monospacedDigit()
                                }
                                HStack(spacing: 14) {
                                    if session.current.websiteItem != nil { Button { changeSource(session) } label: { Image(systemName: "list.bullet.rectangle").frame(width: 44, height: 44) }.accessibilityLabel("Change source") }
                                    Menu {
                                        if session.hasCaptions { Button(session.externalCaptions ? "Turn subtitles off" : "Turn subtitles on") { session.externalCaptions.toggle() } }
                                        ForEach(Array(session.audioOptions.enumerated()), id: \.offset) { _, option in Button("Audio: " + option.displayName) { if let group = session.audioGroup { session.player.currentItem?.select(option, in: group) } } }
                                        ForEach(Array(session.subtitleOptions.enumerated()), id: \.offset) { _, option in Button("Subtitles: " + option.displayName) { if let group = session.subtitleGroup { session.externalCaptions = false; session.player.currentItem?.select(option, in: group) } } }
                                        Button("Subtitles off") { session.externalCaptions = false; if let group = session.subtitleGroup { session.player.currentItem?.select(nil, in: group) } }
                                    } label: { Image(systemName: "captions.bubble").frame(width: 44, height: 44) }.accessibilityLabel("Audio and subtitles")
                                    Menu { ForEach([0.75, 1, 1.25, 1.5, 2], id: \.self) { speed in Button("\(speed.formatted())×") { session.player.rate = Float(speed) } } } label: { Image(systemName: "speedometer").frame(width: 44, height: 44) }.accessibilityLabel("Playback speed")
                                    if let pip = session.pip { Button { pip.startPictureInPicture() } label: { Image(systemName: "pip.enter").frame(width: 44, height: 44) }.accessibilityLabel("Picture in Picture") }
                                    Spacer(minLength: 0)
                                    if session.hasNextEpisode { Button { Task { await session.playNext() } } label: { Label(session.switchingEpisode ? "Loading…" : "Next episode", systemImage: "forward.end.fill") }.disabled(session.switchingEpisode).accessibilityIdentifier("next-episode") }
                                }.font(.subheadline.weight(.medium))
                            }.padding(.horizontal, 20).background(.black.opacity(0.65))
                        }.padding(.top, max(geometry.safeAreaInsets.top, 8)).padding(.bottom, max(geometry.safeAreaInsets.bottom, 8))
                    }
                    if !session.subtitle.isEmpty { VStack { Spacer(); Text(session.subtitle).font(.system(size: 19, weight: .medium)).multilineTextAlignment(.center).padding(8).background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 5)).padding(.bottom, controls ? 150 : 36).accessibilityIdentifier("playback-caption") }.padding(.horizontal, 24) }
                    if let value = session.countdown {
                        VStack { Spacer(); HStack { Spacer(); VStack(alignment: .leading, spacing: 12) { Text("Next episode in \(value)…").font(.headline).accessibilityIdentifier("next-countdown"); HStack { Button("Play now") { Task { await session.playNext() } }; Button("Cancel") { session.cancelCountdown() } } }.padding(20).background(.black.opacity(0.9), in: RoundedRectangle(cornerRadius: 18)).padding(.bottom, controls ? 150 : 36) } }.padding(.horizontal, 20)
                    }
                    if let error = session.failure { VStack(spacing: 16) { Text(error).multilineTextAlignment(.center); Button(retrying ? "Resolving…" : "Retry") { retrying = true; retryTask = Task { do { let fresh = try await store.retryPlayback(store.playback ?? playback); try Task.checkCancellation(); await session.load(fresh.media, url: fresh.url) } catch { session.failure = store.safeMessage(error) }; retrying = false } }.disabled(retrying).buttonStyle(.borderedProminent); if session.current.websiteItem != nil { Button("Try another server") { changeSource(session) } } }.padding(24).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 16)).frame(maxWidth: 480).padding(20) }
                }.frame(width: geometry.size.width, height: geometry.size.height)
            } else { ProgressView("Opening player…").frame(maxWidth: .infinity, maxHeight: .infinity) }
        }.ignoresSafeArea().background(.black).foregroundStyle(.white).statusBarHidden().onAppear { if session == nil { session = PlayerSession(playback: playback, store: store) } }.onDisappear { retryTask?.cancel(); session?.close() }
            .sheet(item: Binding(get: { store.sourceSelection }, set: { store.sourceSelection = $0 }), onDismiss: { if resumeAfterSource, session?.failure == nil { session?.player.play() }; resumeAfterSource = false }) { SourcePicker(selection: $0).environment(store) }
            .onChange(of: store.playback?.revision) { _, _ in if let next = store.playback { Task { await session?.load(next.media, url: next.url) } } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { session?.save() } }
    }
    private func changeSource(_ session: PlayerSession) {
        resumeAfterSource = session.isPlaying; session.save(); session.player.pause()
        Task { do { try await store.requestSources(session.current) } catch { session.failure = store.safeMessage(error) } }
    }
}
struct AirPlayRoute: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView { let view = AVRoutePickerView(); view.tintColor = .white; view.activeTintColor = .white; view.prioritizesVideoDevices = true; return view }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) { }
}
