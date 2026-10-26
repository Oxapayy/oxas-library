import XCTest
import CryptoKit
@testable import OxasLibrary

final class CloudCryptoTests: XCTestCase {
    func testPasswordWrapAndCredentialCiphertextAreAuthenticatedAndScoped() throws {
        let owner = UUID(), password = "fixture-long-password"
        let (settings, key) = try CloudCrypto.create(owner: owner, password: password)
        let restored = try CloudCrypto.unlock(settings, password: password)
        let secret = Data("fixture-server-credential".utf8)
        let box = try CloudCrypto.seal(secret, key: key, owner: owner, purpose: "source:fixture")
        XCTAssertFalse(box.contains("fixture-server-credential"))
        XCTAssertEqual(try CloudCrypto.open(box, key: restored, owner: owner, purpose: "source:fixture"), secret)
        XCTAssertThrowsError(try CloudCrypto.open(box, key: restored, owner: UUID(), purpose: "source:fixture"))
        XCTAssertThrowsError(try CloudCrypto.open(box, key: restored, owner: owner, purpose: "source:other"))
        XCTAssertThrowsError(try CloudCrypto.unlock(settings, password: "fixture-wrong-password"))
        var bytes = Data(base64Encoded: box)!; bytes[bytes.count-1] ^= 1
        XCTAssertThrowsError(try CloudCrypto.open(bytes.base64EncodedString(), key: restored, owner: owner, purpose: "source:fixture"))
    }
    func testPasswordChangeRewrapsSameVaultWithoutReencryptingCredentials() throws {
        let owner = UUID(), old = "fixture-old-password", new = "fixture-new-password"
        let (settings, key) = try CloudCrypto.create(owner: owner, password: old)
        let encrypted = try CloudCrypto.seal(Data("fixture".utf8), key: key, owner: owner, purpose: "source:fixture")
        let changed = try CloudCrypto.rewrap(settings, key: key, password: new)
        XCTAssertEqual(changed.generation, settings.generation)
        XCTAssertNotEqual(changed.salt, settings.salt)
        let unlocked = try CloudCrypto.unlock(changed, password: new)
        XCTAssertEqual(try CloudCrypto.open(encrypted, key: unlocked, owner: owner, purpose: "source:fixture"), Data("fixture".utf8))
        XCTAssertThrowsError(try CloudCrypto.unlock(changed, password: old))
    }
    func testCloudMetadataExcludesCredentialsPlaybackURLsAndLocalPaths() throws {
        let source = UUID()
        var media = Media(id: "fixture", sourceID: source, providerID: "provider", title: "Fixture Film", kind: .movie)
        media.stream = URL(string:"https://example.org/movie?token=private")
        media.poster = URL(string:"https://example.org/image?token=private")
        media.subtitleURL = URL(string:"https://example.org/subtitle?token=private")
        media.playbackHeaders = ["Authorization":"private"]
        media.subtitlePath = "local-caption.vtt"
        let bytes = try JSONEncoder().encode(media.cloudMetadata), text = String(decoding: bytes, as: UTF8.self)
        XCTAssertFalse(text.contains("private")); XCTAssertFalse(text.contains("local-caption")); XCTAssertFalse(text.contains("example.org"))
        XCTAssertEqual(media.cloudMetadata.cloudKey, media.cloudKey)
        var other = media; other.sourceID = UUID(); XCTAssertNotEqual(other.cloudKey, media.cloudKey)
    }
    func testVaultParametersBoundExpensiveWork() throws {
        XCTAssertThrowsError(try CloudCrypto.derive("password", salt: Data(repeating: 1, count: 32), iterations: 20_000_000))
        XCTAssertThrowsError(try CloudCrypto.derive("password", salt: Data(), iterations: 600_000))
    }
    func testTokenBearingProviderIdentitiesNeverReachCloudMetadata() throws {
        let source = UUID()
        let playlist = "#EXTM3U\n#EXTINF:-1,Fixture TV\nhttps://example.org/live/fixture-user/fixture-secret/12?token=fixture-token\n"
        let channel = try XCTUnwrap(M3UParser.parse(playlist, sourceID: source, baseURL: URL(string: "https://example.org")!).first)
        let clean = channel.cloudMetadata
        let bytes = try JSONEncoder().encode(CloudMediaState(media: clean))
        let text = String(decoding: bytes, as: UTF8.self)
        for secret in ["fixture-user", "fixture-secret", "fixture-token", "https://example.org"] { XCTAssertFalse(text.contains(secret)) }
        XCTAssertEqual(clean.cloudKey, channel.cloudKey)
        XCTAssertEqual(clean.cloudMetadata.cloudKey, channel.cloudKey)
        XCTAssertEqual(clean.id, clean.cloudMetadata.id)
        var file = channel; file.kind = .movie; file.providerID = "https://fixture-user:fixture-secret@example.org/library/movie.mp4"; file.seriesID = file.providerID
        let fileJSON = String(decoding: try JSONEncoder().encode(file.cloudMetadata), as: UTF8.self)
        XCTAssertFalse(fileJSON.contains("fixture-secret")); XCTAssertFalse(fileJSON.contains("example.org"))
        XCTAssertEqual(file.cloudMetadata.cloudKey, file.cloudKey)
    }
}
