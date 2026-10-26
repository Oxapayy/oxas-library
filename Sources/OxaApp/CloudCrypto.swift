import Foundation
import CryptoKit
import CommonCrypto

struct VaultSettings: Codable {
    var user_id: UUID
    var generation: UUID
    var salt: String
    var wrapped_key: String
    var iterations: Int
}
struct CachedVaultKey: Codable { var generation: UUID; var key: Data }
enum CloudCrypto {
    static let iterations = 600_000
    static func random(_ count: Int) throws -> Data {
        var bytes = Data(count: count)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        guard status == errSecSuccess else { throw OxaError.message("Secure random generation failed.") }; return bytes
    }
    static func derive(_ password: String, salt: Data, iterations: Int) throws -> SymmetricKey {
        guard (600_000...2_000_000).contains(iterations), salt.count == 32, password.utf8.count <= 1024 else { throw OxaError.message("Unsupported encrypted library settings.") }
        let password = Array(password.utf8); var result = [UInt8](repeating: 0, count: 32)
        let status = salt.withUnsafeBytes { saltBytes in
            password.withUnsafeBytes { passwordBytes in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), passwordBytes.baseAddress?.assumingMemoryBound(to: Int8.self), password.count, saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations), &result, result.count)
            }
        }
        guard status == kCCSuccess else { throw OxaError.message("Could not unlock encrypted server connections.") }
        return SymmetricKey(data: result)
    }
    static func context(_ owner: UUID, _ purpose: String) -> Data { Data("OxaLibrary:v1:\(owner.uuidString.lowercased()):\(purpose)".utf8) }
    static func create(owner: UUID, password: String) throws -> (VaultSettings, SymmetricKey) {
        guard password.count >= 10 else { throw OxaError.message("Use at least 10 characters for your library password.") }
        let key = SymmetricKey(data: try random(32)), salt = try random(32), generation = UUID()
        let wrapping = try derive(password, salt: salt, iterations: iterations)
        let wrapped = try seal(key.withUnsafeBytes { Data($0) }, key: wrapping, owner: owner, purpose: "wrap:\(generation)")
        return (VaultSettings(user_id: owner, generation: generation, salt: salt.base64EncodedString(), wrapped_key: wrapped, iterations: iterations), key)
    }
    static func rewrap(_ settings: VaultSettings, key: SymmetricKey, password: String) throws -> VaultSettings {
        guard password.count >= 10 else { throw OxaError.message("Use at least 10 characters.") }
        let salt = try random(32), wrapping = try derive(password, salt: salt, iterations: iterations)
        var copy = settings; copy.salt = salt.base64EncodedString(); copy.iterations = iterations
        copy.wrapped_key = try seal(key.withUnsafeBytes { Data($0) }, key: wrapping, owner: settings.user_id, purpose: "wrap:\(settings.generation)")
        return copy
    }
    static func unlock(_ settings: VaultSettings, password: String) throws -> SymmetricKey {
        guard let salt = Data(base64Encoded: settings.salt) else { throw OxaError.message("Invalid encrypted library settings.") }
        let wrapping = try derive(password, salt: salt, iterations: settings.iterations)
        let bytes = try open(settings.wrapped_key, key: wrapping, owner: settings.user_id, purpose: "wrap:\(settings.generation)")
        guard bytes.count == 32 else { throw OxaError.message("Invalid library encryption key.") }; return SymmetricKey(data: bytes)
    }
    static func seal(_ data: Data, key: SymmetricKey, owner: UUID, purpose: String) throws -> String {
        guard let box = try AES.GCM.seal(data, using: key, authenticating: context(owner, purpose)).combined else { throw OxaError.message("Could not encrypt server connections.") }
        return box.base64EncodedString()
    }
    static func open(_ text: String, key: SymmetricKey, owner: UUID, purpose: String) throws -> Data {
        guard let data = Data(base64Encoded: text), data.count <= 512 * 1024 else { throw OxaError.message("Invalid encrypted connection.") }
        return try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key, authenticating: context(owner, purpose))
    }
}
