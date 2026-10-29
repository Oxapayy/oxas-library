import Foundation

/// A newer iOS release published on GitHub. The app is sideloaded, so it can
/// only point people to the new IPA; installing stays with ESign or AltStore.
struct AppRelease: Equatable, Sendable {
    let version: String
    let page: URL
}

enum UpdateCheck {
    private struct Release: Decodable {
        let tag_name: String
        let draft: Bool?
        let prerelease: Bool?
        let html_url: URL
        let assets: [Asset]
        struct Asset: Decodable { let name: String }
    }
    static var current: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    /// Compares dotted numeric versions, so 1.3.10 is newer than 1.3.9.
    static func newer(_ candidate: String, than current: String) -> Bool {
        let a = candidate.split(separator: ".").map { Int($0) ?? 0 }, b = current.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    /// Picks the newest published iOS release that ships an IPA. Desktop
    /// releases use their own `desktop-v` tags and are ignored.
    static func pick(_ data: Data, current: String) -> AppRelease? {
        guard let releases = try? JSONDecoder().decode([Release].self, from: data) else { return nil }
        var best: AppRelease?
        for release in releases where release.draft != true && release.prerelease != true {
            guard release.tag_name.hasPrefix("v"), case let version = String(release.tag_name.dropFirst()),
                  version.split(separator: ".").count == 3, version.allSatisfy({ $0.isNumber || $0 == "." }),
                  newer(version, than: current), best.map({ newer(version, than: $0.version) }) ?? true,
                  release.assets.contains(where: { $0.name == "Oxas-Library-v\(version)-iOS-unsigned.ipa" }) else { continue }
            best = AppRelease(version: version, page: release.html_url)
        }
        return best
    }

    /// Returns nil when no newer release exists and throws when the check failed.
    static func latest(current: String = current) async throws -> AppRelease? {
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/Oxapayy/oxas-library/releases?per_page=30")!, timeoutInterval: 20)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return pick(data, current: current)
    }
}
