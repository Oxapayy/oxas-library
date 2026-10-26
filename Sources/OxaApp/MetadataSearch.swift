import SwiftUI

struct MetadataHit: Identifiable {
    let id: Int
    let title: String
    let overview: String
    let poster: URL?
    let backdrop: URL?
}
struct MetadataSearch: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let media: Media
    @State private var hits: [MetadataHit] = []
    @State private var busy = true
    @State private var message: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Choose the matching title. Artwork and descriptions are provided by TMDB.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                    if busy { ProgressView("Searching TMDB…") }
                    if let message { Text(message).foregroundStyle(OxaTheme.secondary) }
                    ForEach(hits) { hit in
                        Button {
                            if let index = store.state.media.firstIndex(where: { $0.id == media.id }) { store.state.media[index].poster = hit.poster; store.state.media[index].backdrop = hit.backdrop; store.state.media[index].overview = hit.overview }
                            store.save(); dismiss()
                        } label: {
                            HStack(alignment: .top, spacing: 16) {
                                if let poster = hit.poster { SafeArtwork(url: poster).frame(width: 66, height: 99).clipped() }
                                VStack(alignment: .leading, spacing: 8) { Text(hit.title).font(.headline); Text(hit.overview).font(.subheadline).foregroundStyle(OxaTheme.secondary).lineLimit(4) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(PressStyle())
                    }
                }.padding(20)
            }.background(.black).navigationTitle("Choose Artwork").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }.task { await search() }
        }.preferredColorScheme(.dark)
    }
    private func search() async {
        defer { busy = false }
        guard store.state.preferences.externalMetadata else { message = "Enable optional TMDB artwork in Settings first."; return }
        do {
            guard let data = try store.vault.read("tmdb-token"), let token = String(data: data, encoding: .utf8), !token.isEmpty else { throw OxaError.message("Save your TMDB API read access token in Settings first.") }
            let kind = media.kind == .series || media.kind == .episode ? "tv" : "movie"
            var parts = URLComponents(string: "https://api.themoviedb.org/3/search/\(kind)")!
            parts.queryItems = [URLQueryItem(name: "query", value: media.displayTitle), URLQueryItem(name: "language", value: "en-US"), URLQueryItem(name: "include_adult", value: "false")]
            let source = MediaSource(name: "TMDB", kind: .direct, host: "api.themoviedb.org")
            let response = try await HTTPClient.shared.data(parts.url!, source: source, headers: ["Authorization": "Bearer \(token)", "Accept": "application/json"])
            let box = try JSONSerialization.jsonObject(with: response) as? [String: Any]
            hits = (box?["results"] as? [[String: Any]] ?? []).compactMap { row in
                guard let id = row["id"] as? Int, let title = row["title"] as? String ?? row["name"] as? String else { return nil }
                return MetadataHit(id: id, title: title, overview: row["overview"] as? String ?? "", poster: (row["poster_path"] as? String).flatMap { URL(string: "https://image.tmdb.org/t/p/w500\($0)") }, backdrop: (row["backdrop_path"] as? String).flatMap { URL(string: "https://image.tmdb.org/t/p/w1280\($0)") })
            }
            if hits.isEmpty { message = "No matching title was found." }
        } catch { message = store.safeMessage(error) }
    }
}
