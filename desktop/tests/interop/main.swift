// Public test vectors only. Never use these keys or credentials in production.
import Foundation
import CryptoKit

let owner = UUID(uuidString: "A1B2C3D4-1111-4222-8333-ABCDEF123456")!
let generation = UUID(uuidString: "B1B2C3D4-1111-4222-8333-ABCDEF123456")!
let keyBytes = Data((0..<32).map(UInt8.init))
let key = SymmetricKey(data: keyBytes)
let password = "Fixture password 27!"
if CommandLine.arguments[1] == "generate" {
    let salt = Data((32..<64).map(UInt8.init))
    let wrapping = try CloudCrypto.derive(password, salt: salt, iterations: 600_000)
    let settings = VaultSettings(user_id: owner, generation: generation, salt: salt.base64EncodedString(), wrapped_key: try CloudCrypto.seal(keyBytes, key: wrapping, owner: owner, purpose: "wrap:\(generation)"), iterations: 600_000)
    let source = MediaSource(id: owner, name: "Fixture server", kind: .jellyfin, host: "example.org")
    var credentials = Credentials(endpoint: "https://example.org/"); credentials.username = "fixture"; credentials.password = "fixture-only"
    let purpose = "source:\(generation):\(owner)"
    let encrypted = try CloudCrypto.seal(JSONEncoder().encode(CloudSource(source: source, credentials: credentials)), key: key, owner: owner, purpose: purpose)
    let object: [String: Any] = ["owner": owner.uuidString, "key": keyBytes.base64EncodedString(), "password": password, "settings": try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)), "sourcePurpose": purpose, "encryptedSource": encrypted]
    try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
} else {
    let json = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as! [String: Any]
    let settings = try JSONDecoder().decode(VaultSettings.self, from: JSONSerialization.data(withJSONObject: json["settings"]!))
    let unlocked = try CloudCrypto.unlock(settings, password: password)
    precondition(unlocked.withUnsafeBytes { Data($0) } == keyBytes)
    let payload = try CloudCrypto.open(json["encryptedSource"] as! String, key: unlocked, owner: owner, purpose: "source:\(generation):\(owner)")
    let source = try JSONDecoder().decode(CloudSource.self, from: payload)
    precondition(source.source.id == owner && source.credentials.username == "fixture")
    let media = try JSONDecoder().decode(CloudMediaState.self, from: JSONSerialization.data(withJSONObject: json["watch"]!))
    precondition(media.media.subtitleDelay == 0 && media.progress?.seconds == 12.5)
    precondition(media.media.cloudKey == media.media.cloudIdentity)
    print("Swift decoded desktop credentials, key wrapping and watch state.")
}
