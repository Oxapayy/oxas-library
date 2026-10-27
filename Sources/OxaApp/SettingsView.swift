import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @State private var editing: MediaSource?
    @State private var removing: MediaSource?
    @State private var metadataKey = ""
    @State private var keySaved = false
    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                HStack(spacing: 14) { OxaMark(size: 36); VStack(alignment: .leading, spacing: 4) { Text("Oxa’s Library").font(.headline); Text("Your collection. On your terms.").font(.subheadline).foregroundStyle(OxaTheme.secondary) } }.padding(.vertical, 10)
            }
            Section {
                NavigationLink { AccountView().environment(store) } label: {
                    HStack { Label("Account", systemImage: "person.crop.circle"); Spacer(); Text(store.account?.identity == nil ? "Optional" : "Signed in").foregroundStyle(OxaTheme.secondary).font(.subheadline) }
                }.disabled(store.preview).accessibilityIdentifier("account-settings")
            }
            Section {
                ForEach(store.sources) { source in
                    VStack(alignment: .leading, spacing: 8) {
                        Button { editing = source } label: {
                            HStack { Image(systemName: source.kind.icon).foregroundStyle(OxaTheme.secondary); VStack(alignment: .leading, spacing: 4) { Text(source.name); Text("\(source.kind.rawValue) · \(source.host)").font(.caption).foregroundStyle(OxaTheme.secondary) }; Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(OxaTheme.secondary) }
                        }.disabled(store.preview)
                        if let notice = store.notices[source.id] { Text(notice).font(.caption).foregroundStyle(OxaTheme.secondary) }
                        if let refreshed = source.refreshedAt { Text("Updated \(refreshed.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(OxaTheme.secondary) }
                        HStack {
                            Button { Task { await store.refresh(source) } } label: { if store.refreshing.contains(source.id) { ProgressView() } else { Text("Refresh") } }.disabled(store.preview || store.refreshing.contains(source.id))
                            Spacer(); Button("Remove", role: .destructive) { removing = source }.disabled(store.preview)
                        }.font(.subheadline).frame(minHeight: 32)
                    }.padding(.vertical, 6).buttonStyle(.borderless)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) { Button("Remove", role: .destructive) { removing = source } }
                }
                Button { store.showAddSource = true } label: { Label("Add Source", systemImage: "plus") }.disabled(store.preview)
            } header: { Text("Sources") } footer: { Text("Multiple servers appear together in Library. Refreshing reads the catalog; playback progress is never sent to the server.") }
            Section {
                Toggle("Play next episode automatically", isOn: $store.state.preferences.autoplay).tint(OxaTheme.accent)
                Picker("Audio language", selection: $store.state.preferences.audioLanguage) { Text("English").tag("en"); Text("German").tag("de") }
                Picker("Subtitle language", selection: $store.state.preferences.subtitleLanguage) { Text("English").tag("en"); Text("German").tag("de"); Text("Off").tag("off") }
            } header: { Text("Playback") } footer: { Text("Language preferences apply when those tracks are available. Choose another track in the player at any time.") }
            Section {
                Label("Wi-Fi and mobile data", systemImage: "antenna.radiowaves.left.and.right")
                Text("Downloads remain until you delete them. Deleting a video keeps its watch progress.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
            } header: { Text("Downloads") }
            Section {
                Toggle("Find missing artwork with TMDB", isOn: $store.state.preferences.externalMetadata).tint(OxaTheme.accent)
                if store.state.preferences.externalMetadata {
                    SecureField("TMDB API read access token", text: $metadataKey).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button(keySaved ? "Token Saved" : "Save TMDB Token") {
                        do { try store.vault.write(Data(metadataKey.trimmingCharacters(in: .whitespacesAndNewlines).utf8), key: "tmdb-token"); keySaved = true } catch { store.error = store.safeMessage(error) }
                    }
                    Text("Use Find Cover & Description on a title to search. Only that title is sent to TMDB; your server address and credentials are never sent.").font(.caption).foregroundStyle(OxaTheme.secondary)
                }
            } header: { Text("Optional artwork") } footer: { VStack(alignment: .leading, spacing: 10) { Image("TMDBLogo").resizable().scaledToFit().frame(width: 77, height: 10).accessibilityLabel("The Movie Database"); Text("This product uses the TMDB API but is not endorsed or certified by TMDB.") } }
            Section {
                Label(store.accountID == nil ? "Local library · No account required" : "Account sync · Automatic", systemImage: "lock")
                Label("Credentials stored in Keychain", systemImage: "key")
                Text("Your local catalog is encrypted. Optional account sync stores viewing history, watchlist and server connections in your account, protected by account access controls. No analytics. Downloads stay on this iPhone.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                Text("Interface language: English").font(.subheadline).foregroundStyle(OxaTheme.secondary)
            } header: { Text("Privacy") }
            Section {
                NavigationLink("Support Oxa") {
                    Form {
                        Section { Text("Optional donations help support development. All features stay free.") }
                        Section("Bitcoin · BTC") { Text("3KZ8qzJpBZSj9BazUMqUcG761UpVivQKGV").font(.footnote.monospaced()).textSelection(.enabled); ShareLink("Share Address", item: "3KZ8qzJpBZSj9BazUMqUcG761UpVivQKGV"); Button("Copy Address") { UIPasteboard.general.string = "3KZ8qzJpBZSj9BazUMqUcG761UpVivQKGV" } }
                        Section("Litecoin · LTC") { Text("MTToUVnMpepWixDhUPBBG1SgdmxjifArwF").font(.footnote.monospaced()).textSelection(.enabled); ShareLink("Share Address", item: "MTToUVnMpepWixDhUPBBG1SgdmxjifArwF"); Button("Copy Address") { UIPasteboard.general.string = "MTToUVnMpepWixDhUPBBG1SgdmxjifArwF" } }
                    }.navigationTitle("Support Oxa").scrollContentBackground(.hidden).background(.black)
                }
            }
            Section {
                if store.preview { Button("Leave Preview Library") { store.leavePreview() } }
                else { Button("Explore Preview Library") { store.enablePreview(); store.selectedTab = 0 }.disabled(!store.sources.isEmpty) }
                Text("Version 1.3 · Personal library").font(.caption).foregroundStyle(OxaTheme.secondary)
            }
        }.scrollContentBackground(.hidden).background(.black).navigationTitle("Settings").navigationBarTitleDisplayMode(.inline).tint(.white)
            .sheet(item: $editing) { source in SourceEditor(existing: source).environment(store) }
            .confirmationDialog("Remove this source? Saved downloads and watch progress will be kept. You can delete downloads separately.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                if let source = removing { Button("Remove Source", role: .destructive) { store.removeSource(source); removing = nil } }
            }
            .onChange(of: store.state.preferences.autoplay) { store.save(); store.account?.preferencesChanged() }
            .onChange(of: store.state.preferences.audioLanguage) { store.save(); store.account?.preferencesChanged() }
            .onChange(of: store.state.preferences.subtitleLanguage) { store.save(); store.account?.preferencesChanged() }
            .onChange(of: store.state.preferences.externalMetadata) { store.save(); store.account?.preferencesChanged() }
            .onAppear { if let data = try? store.vault.read("tmdb-token"), let text = String(data: data, encoding: .utf8) { metadataKey = text } }
    }
}
