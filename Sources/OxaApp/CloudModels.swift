import Foundation
import CryptoKit

struct AccountIdentity: Codable { var id: UUID; var email: String }
struct CloudPayload: Codable {
    var value: String
    var format: String?
    init(value: String, format: String? = nil) { self.value = value; self.format = format }
    enum CodingKeys: String, CodingKey { case value, format }
    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        value = try fields.decodeIfPresent(String.self, forKey: .value) ?? ""
        format = try fields.decodeIfPresent(String.self, forKey: .format)
    }
}
struct CloudChange: Codable, Identifiable {
    var kind: String
    var key: String
    var payload: CloudPayload
    var deleted: Bool
    var base_revision: Int64
    var mutationID = UUID()
    var id: String { "\(kind):\(key)" }
}
struct CloudRecord: Codable {
    var kind: String; var key: String; var payload: CloudPayload; var deleted: Bool; var revision: Int64
    var id: String { "\(kind):\(key)" }
}
struct CloudConflict: Codable { var kind: String; var key: String }
struct CloudReply: Codable { var records: [CloudRecord]; var conflicts: [CloudConflict]; var generation: UUID }
struct CloudRequest: Encodable { var changes: [CloudChange]; var after_revision: Int64; var expected_generation: UUID }
struct CloudSource: Codable { var source: MediaSource; var credentials: Credentials }
struct CloudMediaState: Codable { var media: Media; var progress: WatchProgress? }
struct SyncJournal: Codable {
    var generation: UUID?
    var cursor: Int64 = 0
    var revisions: [String: Int64] = [:]
    var pending: [String: CloudChange] = [:]
    var initialized = false
}
extension Media {
    var cloudKey: String {
        if let cloudIdentity, cloudIdentity.count == 64, cloudIdentity.allSatisfy({ $0.isHexDigit }) { return cloudIdentity }
        var value: String
        if let ref = websiteItem, let namespace = ["tmdb", "imdb"].first(where: { ref.ids[$0] != nil }), let id = ref.ids[namespace] { value = "\(kind.rawValue):\(namespace):\(id)" }
        else { value = "\(sourceID):\(providerID):\(kind.rawValue)" }
        return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    var cloudMetadata: Media {
        var copy = self
        let identity = cloudKey
        // Provider IDs can themselves contain full credential-bearing URLs (M3U/WebDAV).
        if cloudIdentity == nil {
            func opaque(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
            copy.id = "cloud:\(identity)"; copy.providerID = opaque(providerID)
            copy.seriesID = seriesID.map(opaque); copy.channelID = nil
        }
        copy.cloudIdentity = identity
        copy.stream = nil; copy.poster = nil; copy.backdrop = nil; copy.subtitleURL = nil; copy.subtitlePath = nil
        copy.playbackHeaders = nil; copy.websiteResolved = nil; copy.streamFormat = nil
        copy.websiteItem = nil; copy.downloadPreference = nil
        return copy
    }
}
