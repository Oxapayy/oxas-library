import Foundation
import Supabase

// Public project configuration only. RLS, never this publishable key, authorizes user data.
enum CloudConfiguration {
    static let url = URL(string: "https://kexzbnhmymvbrijopayi.supabase.co")!
    static let key = "sb_publishable_TlKCX8wPX61T8ECcQ4sfQw_-P3Vrwqb"
    static let callback = URL(string: "oxaslibrary://auth/callback")!
}
struct AuthKeychainStorage: AuthLocalStorage {
    func store(key: String, value: Data) throws { try Vault().write(value, key: "auth-" + key) }
    func retrieve(key: String) throws -> Data? { try Vault().read("auth-" + key) }
    func remove(key: String) throws { try Vault().remove("auth-" + key) }
}
struct AuthReadiness: Codable { var auth_emails_ready: Bool }
