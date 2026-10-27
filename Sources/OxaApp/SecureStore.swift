import Foundation
import Security
import CryptoKit

final class Vault {
    var namespace = ""
    static let service = "app.oxas.library"
    func read(_ key: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: namespace + key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw OxaError.message("Secure storage is unavailable. Unlock your iPhone and try again.") }
        return result as? Data
    }
    func write(_ data: Data, key: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: namespace + key]
        let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(update) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw OxaError.message("Could not save to secure storage.") }
    }
    func remove(_ key: String) throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: namespace + key] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw OxaError.message("Could not remove the saved credentials.") }
    }
    func credentials(_ id: UUID) throws -> Credentials {
        guard let data = try read(id.uuidString) else { throw OxaError.message("Reconnect this source in Settings.") }
        return try JSONDecoder().decode(Credentials.self, from: data)
    }
    func save(_ credentials: Credentials, id: UUID) throws { try write(JSONEncoder().encode(credentials), key: id.uuidString) }
}
class EncryptedDisk {
    let vault: Vault
    let root: URL
    let mediaRoot: URL
    init(root: URL? = nil, mediaRoot: URL? = nil, vault: Vault = Vault()) throws {
        self.vault = vault
        self.root = try root ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Oxa", isDirectory: true)
        self.mediaRoot = try mediaRoot ?? FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Downloads", isDirectory: true)
        for folder in [self.root, self.mediaRoot] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var excluded = folder; var values = URLResourceValues(); values.isExcludedFromBackup = true; try excluded.setResourceValues(values)
        }
    }
    private func key() throws -> SymmetricKey {
        if let data = try vault.read("catalog-key") { return SymmetricKey(data: data) }
        // Never replace a missing encryption key when a catalog already exists.
        if FileManager.default.fileExists(atPath: root.appendingPathComponent("library.sealed").path) { throw OxaError.message("The local library key is missing. Existing data has been preserved.") }
        let key = SymmetricKey(size: .bits256)
        try vault.write(key.withUnsafeBytes { Data($0) }, key: "catalog-key"); return key
    }
    func load() throws -> LibrarySnapshot {
        let path = root.appendingPathComponent("library.sealed")
        guard FileManager.default.fileExists(atPath: path.path) else { return LibrarySnapshot() }
        let data = try Data(contentsOf: path)
        return try JSONDecoder().decode(LibrarySnapshot.self, from: AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key()))
    }
    func loadNamed<T: Decodable>(_ name: String, as: T.Type) throws -> T? {
        guard name.range(of: "^[a-zA-Z0-9-]+$", options: .regularExpression) != nil else { throw OxaError.message("Invalid local storage name.") }
        let path = root.appendingPathComponent(name + ".sealed")
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        return try JSONDecoder().decode(T.self, from: AES.GCM.open(AES.GCM.SealedBox(combined: Data(contentsOf: path)), using: key()))
    }
    func saveNamed<T: Encodable>(_ value: T, name: String) throws {
        guard name.range(of: "^[a-zA-Z0-9-]+$", options: .regularExpression) != nil else { throw OxaError.message("Invalid local storage name.") }
        let box = try AES.GCM.seal(JSONEncoder().encode(value), using: key())
        guard let bytes = box.combined else { throw OxaError.message("Could not encrypt local state.") }
        try bytes.write(to: root.appendingPathComponent(name + ".sealed"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func removeNamed(_ name: String) throws {
        guard name.range(of: "^[a-zA-Z0-9-]+$", options: .regularExpression) != nil else { return }
        let path = root.appendingPathComponent(name + ".sealed")
        if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
    }
    func save(_ snapshot: LibrarySnapshot) throws {
        let encrypted = try AES.GCM.seal(JSONEncoder().encode(snapshot), using: key())
        guard let data = encrypted.combined else { throw OxaError.message("Could not encrypt the local library.") }
        try data.write(to: root.appendingPathComponent("library.sealed"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
