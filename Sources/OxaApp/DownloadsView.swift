import SwiftUI

struct DownloadsView: View {
    @Environment(AppStore.self) private var store
    @State private var deletion: Transfer?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if store.state.transfers.isEmpty {
                    EmptyPanel(title: "Take your library with you", message: "Download a film, an episode or a whole season from its details. Saved videos stay here until you delete them.", icon: "arrow.down.circle")
                    Text("Downloads use Wi-Fi or mobile data. Your watch progress stays on this iPhone, even after deleting a video.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                } else {
                    HStack { Text("\(store.state.transfers.filter { $0.state == .ready }.count) saved offline"); Spacer(); Text(ByteCountFormatter.string(fromByteCount: store.state.transfers.reduce(0) { $0 + ($1.state == .ready ? $1.bytes : 0) }, countStyle: .file)) }.font(.subheadline).foregroundStyle(OxaTheme.secondary)
                    ForEach(store.state.transfers) { transfer in
                        VStack(alignment: .leading, spacing: 14) {
                            MediaRow(media: transfer.media)
                            if transfer.state == .downloading || transfer.state == .queued {
                                ProgressView(value: transfer.fraction).tint(OxaTheme.accent)
                                HStack { Text(transfer.state == .queued ? "Queued" : "\(Int(transfer.fraction * 100))% · \(ByteCountFormatter.string(fromByteCount: transfer.bytes, countStyle: .file))"); Spacer(); Button("Cancel") { store.downloads.cancel(transfer.id) } }.font(.subheadline)
                            } else if transfer.state == .ready {
                                HStack {
                                    Button { Task { await store.play(transfer.media) } } label: { Label("Play Offline", systemImage: "play.fill").frame(minHeight: 44) }
                                    Spacer()
                                    Button(role: .destructive) { deletion = transfer } label: { Image(systemName: "trash").frame(width: 44, height: 44) }.accessibilityLabel("Delete download of \(transfer.media.title)")
                                }
                            } else {
                                Text(transfer.error ?? "Download cancelled.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                                HStack { Button("Retry") { store.downloads.enqueue(transfer.media) }; Spacer(); Button("Remove", role: .destructive) { store.downloads.delete(transfer.id) } }.font(.subheadline).frame(minHeight: 44)
                            }
                        }.padding(16).background(OxaTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                    }
                }
            }.padding(20)
        }.background(.black).navigationTitle("Downloads").navigationBarTitleDisplayMode(.inline)
            .confirmationDialog("Delete this downloaded video? Your watch progress will be kept.", isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }), titleVisibility: .visible) {
                if let transfer = deletion { Button("Delete Download", role: .destructive) { store.downloads.delete(transfer.id); deletion = nil } }
            }
    }
}
