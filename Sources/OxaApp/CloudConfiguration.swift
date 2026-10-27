import Foundation
import Supabase

// Public client connection values are injected privately when producing hosted builds.
// No service-role, SMTP or administrator credentials belong in a client app.
enum CloudConfiguration {
    private static let values: [String: String] = {
        guard let file = Bundle.main.url(forResource: "Cloud.local", withExtension: "json"),
              let bytes = try? Data(contentsOf: file),
              let values = try? JSONDecoder().decode([String: String].self, from: bytes) else { return [:] }
        return values
    }()
    static let isConfigured = URL(string: values["url"] ?? "")?.scheme == "https" && URL(string: values["url"] ?? "")?.host != nil && !(values["publishableKey"] ?? "").isEmpty
    static let url = isConfigured ? URL(string: values["url"]!)! : URL(string: "https://example.invalid")!
    static let key = values["publishableKey"] ?? "not-configured"
    static let callback = URL(string: "oxaslibrary://auth/callback")!
}
struct AuthKeychainStorage: AuthLocalStorage {
    func store(key: String, value: Data) throws { try Vault().write(value, key: "auth-" + key) }
    func retrieve(key: String) throws -> Data? { try Vault().read("auth-" + key) }
    func remove(key: String) throws { try Vault().remove("auth-" + key) }
}
struct AuthReadiness: Codable { var auth_emails_ready: Bool }
