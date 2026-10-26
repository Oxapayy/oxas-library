import SwiftUI
import UIKit

struct SourceEditor: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var existing: MediaSource? = nil
    @State private var kind: SourceKind = .website
    @State private var name = ""
    @State private var endpoint = ""
    @State private var username = ""
    @State private var password = ""
    @State private var token = ""
    @State private var userID = ""
    @State private var guideURL = ""
    @State private var allowHTTP = false
    @State private var allowInsecureStreams = false
    @State private var busy = false
    @State private var message: String?
    @State private var connectionTask: Task<Void, Never>?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Source type", selection: $kind) { ForEach(SourceKind.allCases) { kind in Text(kind.rawValue).tag(kind) } }.disabled(existing != nil).accessibilityIdentifier("source-kind")
                    TextField("Source name", text: $name).textContentType(.none).accessibilityIdentifier("source-name")
                    TextField(kind == .m3u ? "Playlist URL" : kind == .direct ? "Video URL" : kind == .website ? "Library URL" : "Server URL", text: $endpoint).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("source-url")
                } header: { Text("Connection") } footer: { Text(help) }
                if [.jellyfin, .emby, .xtream, .webdav].contains(kind) {
                    Section {
                        TextField("Username", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
                        SecureField(existing != nil && !token.isEmpty && (kind == .jellyfin || kind == .emby) ? "Password (leave blank to keep session)" : "Password", text: $password).textContentType(.password)
                    } header: { Text(kind == .webdav ? "Login (optional)" : "Login") }
                }
                if kind == .plex {
                    Section { SecureField("Plex token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled() } header: { Text("Authentication") } footer: { Text("Use a token authorized to access this Plex server. It is stored in the iPhone Keychain.") }
                }
                if kind.isTV {
                    Section { TextField("XMLTV URL (optional)", text: $guideURL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled() } header: { Text("Program guide") } footer: { Text("M3U guide URLs are detected from the playlist when available. Xtream Codes uses the provider’s guide unless you specify one here.") }
                }
                Section {
                    Toggle("Allow local HTTP", isOn: $allowHTTP).tint(OxaTheme.accent).accessibilityIdentifier("source-http")
                } footer: { Text(allowHTTP ? "HTTP does not encrypt your login or media traffic. Use it only on a trusted local network. Internet addresses require HTTPS." : "HTTPS verifies your server and encrypts the connection. Enable local HTTP only if your home server needs it.") }
                if [.website, .m3u, .xtream, .direct].contains(kind) {
                    Section { Toggle("Allow HTTP streams", isOn: $allowInsecureStreams).tint(OxaTheme.accent) } footer: { Text("Some live-TV providers use unencrypted media links. Enable only if you trust the source. Server login and catalog requests still require HTTPS outside your home network.") }
                }
                if kind == .website && existing == nil {
                    Section { Button("Use huhu.to") { endpoint = "https://huhu.to"; name = "huhu.to" } } footer: { Text("Suggested library URL. You can connect your own Jellyfin, Plex or another supported source instead. Stream availability depends on the provider.") }
                }
                if let message { Section { Text(message).foregroundStyle(.white).font(.subheadline).accessibilityIdentifier("source-error") } }
                Section { Text("Watch history and favorites stay on this iPhone unless you enable optional account sync.").font(.footnote).foregroundStyle(OxaTheme.secondary) }

            }.scrollDismissesKeyboard(.interactively).scrollContentBackground(.hidden).background(.black).tint(.white).navigationTitle(existing == nil ? "Add Source" : "Edit Source").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button(busy ? "Connecting…" : existing == nil ? "Connect" : "Save") { connect() }.disabled(busy || endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("connect-source") }
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { connectionTask?.cancel(); dismiss() } }
                    ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) } }
                }
                .interactiveDismissDisabled(busy)
                .onAppear {
                    if let existing {
                        kind = existing.kind; name = existing.name; allowHTTP = existing.allowHTTP; allowInsecureStreams = existing.allowInsecureStreams == true
                        do { let saved = try store.vault.credentials(existing.id); endpoint = saved.endpoint; username = saved.username; password = saved.password; token = saved.token; userID = saved.userID; guideURL = saved.guideURL }
                        catch { message = store.safeMessage(error) }
                    }
                }
        }.preferredColorScheme(.dark)
    }
    private func connect() {
                        busy = true; message = nil
                        connectionTask = Task {
                            do {
                                let credentials = Credentials(endpoint: endpoint.trimmingCharacters(in: .whitespacesAndNewlines), username: username, password: password, token: token, userID: userID, guideURL: guideURL.trimmingCharacters(in: .whitespacesAndNewlines))
                                try await store.addSource(name: name, kind: kind, credentials: credentials, allowHTTP: allowHTTP, existing: existing, allowInsecureStreams: allowInsecureStreams)
                                dismiss()
                            } catch { message = store.safeMessage(error) }
                            busy = false
                        }
    }
    private var help: String {
        switch kind {
        case .jellyfin: "Enter the full Jellyfin server address, including a port or base path if used. Example: https://media.example.com"
        case .emby: "Enter your Emby server’s full address, including its base path if needed."
        case .plex: "Enter the Plex server address, such as https://plex.example.com. Automatic plex.tv discovery is not required."
        case .webdav: "Enable WebDAV on your NAS and enter a media folder URL. SMB shares use a different protocol and cannot be added here."
        case .website: "Import movies, series, covers and live channels from a website exposing a mHub v2 library. Enter its home URL or addon URL. The website’s declared catalog providers are loaded as part of this source; a catalog entry does not guarantee a playable stream."
        case .direct: "For one video file only. For a whole website collection choose Library URL. Enter a direct MP4, MOV or HLS video link. Web pages with embedded players are not direct video URLs."
        case .m3u: "Enter an extended M3U channel playlist URL from a provider you are authorized to use."
        case .xtream: "Enter the provider’s base server address, then your Xtream username and password."
        }
    }
}
