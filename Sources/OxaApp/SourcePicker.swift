import SwiftUI

struct SourceSelection: Identifiable {
    let id = UUID()
    var media: Media
    var choices: [WebsiteStream]
    var download = false
    var batch: [Media] = []
}
struct SourcePicker: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let selection: SourceSelection
    @State private var resolving: String?
    @State private var message: String?
    @State private var attempt = UUID()
    @State private var task: Task<Void, Never>?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(selection.media.displayTitle).font(.headline)
                    if selection.media.kind == .episode { Text("\(selection.media.episodeLabel) · \(selection.media.title)").font(.subheadline).foregroundStyle(OxaTheme.secondary) }
                }
                Section {
                    ForEach(selection.choices) { choice in
                        if choice.kind == "website" {
                            Link(destination: choice.url) { Label("Open \(choice.name)", systemImage: "arrow.up.right.square") }
                        } else {
                            Button {
                                task?.cancel(); let token = UUID(); attempt = token; resolving = choice.id; message = nil
                                task = Task {
                                    do { try await store.selectSource(selection, choice: choice); dismiss() }
                                    catch is CancellationError { }
                                    catch { if token == attempt { message = store.safeMessage(error) } }
                                    if token == attempt { resolving = nil }
                                }
                            } label: {
                                HStack(spacing: 16) {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(choice.name).font(.body.weight(.semibold))
                                        Text([choice.providerName, choice.quality, choice.languages?.map { Locale(identifier: "en").localizedString(forLanguageCode: $0) ?? $0 }.joined(separator: ", ")].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")).font(.subheadline).foregroundStyle(OxaTheme.secondary)
                                    }
                                    Spacer()
                                    if resolving == choice.id { ProgressView() } else { Image(systemName: selection.download ? "arrow.down" : "play.fill").font(.subheadline) }
                                }.frame(minHeight: 44).contentShape(Rectangle())
                            }.accessibilityIdentifier("play-source-\(choice.name)")
                        }
                    }
                } header: { Text(selection.download ? "Download from" : "Available servers") }
                if selection.choices.isEmpty { Text("No sources are available for this title. Refresh the library or try another title.").foregroundStyle(OxaTheme.secondary) }
                if let source = store.source(selection.media.sourceID) {
                    Section {
                        Toggle("Provider-assisted requests", isOn: Binding(get: { store.source(source.id)?.allowProviderFetch == true }, set: { allowed in
                            if let i = store.state.sources.firstIndex(where: { $0.id == source.id }) { store.state.sources[i].allowProviderFetch = allowed; store.save(); store.account?.sourceChanged(store.state.sources[i]) }
                        })).tint(OxaTheme.accent)
                        Toggle("Allow HTTP streams", isOn: Binding(get: { store.source(source.id)?.allowInsecureStreams == true }, set: { allowed in
                            if let i = store.state.sources.firstIndex(where: { $0.id == source.id }) { store.state.sources[i].allowInsecureStreams = allowed; store.save(); store.account?.sourceChanged(store.state.sources[i]) }
                        })).tint(OxaTheme.accent)
                    } footer: { Text("HTTP media links are unencrypted. Enable them only for a trusted source. Some servers ask your iPhone to fetch a public host page and send its response to this library provider. Your Oxa account and saved server credentials are never included.") }
                }
                if let message { Section { Text(message).font(.subheadline); Text("Your watch progress is kept.").foregroundStyle(OxaTheme.secondary) }.accessibilityIdentifier("source-playback-error") }
            }.scrollContentBackground(.hidden).background(.black).navigationTitle("Sources").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { task?.cancel(); dismiss() } } }
                .onDisappear { task?.cancel() }
        }.preferredColorScheme(.dark).tint(.white)
    }
}
