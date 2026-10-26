import Foundation

/// mHub data exchange: isolated public fetches, no app credentials, no script execution.
struct ClientFetchExchange {
    let source: MediaSource
    let endpoint: URL
    func complete(_ initial: [String: Any], resolverRequest: URL) async throws -> [String: Any] {
        let callback = resolverRequest.deletingLastPathComponent().appendingPathComponent("client-fetch")
        guard URLPolicy.sameOrigin(callback, resolverRequest), callback.scheme == "https" || URLPolicy.isLocal(endpoint.host ?? "") && source.allowHTTP else { throw OxaError.message("The provider callback is not secure.") }
        var result = initial
        for _ in 0..<5 {
            try Task.checkCancellation()
            guard let fetch = result["clientFetch"] as? [String: Any] else {
                if result["error"] != nil { throw OxaError.message("This provider could not resolve the selected server.") }
                return result
            }
            guard source.allowProviderFetch == true, let id = fetch["id"] as? String, id.count <= 256, let raw = fetch["url"] as? String, let url = URL(string: raw) else { throw OxaError.message("The provider returned an invalid request.") }
            let method = (fetch["method"] as? String ?? "GET").uppercased()
            guard ["GET", "HEAD", "POST"].contains(method) else { throw OxaError.message("This provider requested an unsupported operation.") }
            var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 20
            let body = Data((fetch["body"] as? String ?? "").utf8)
            guard body.count <= 64 * 1024 else { throw OxaError.message("The provider request is too large.") }
            if method == "POST" { request.httpBody = body }
            for (key, value) in fetch["headers"] as? [String: String] ?? [:] where ["user-agent", "accept", "accept-language", "content-type", "referer", "origin"].contains(key.lowercased()) && !value.contains("\r") && !value.contains("\n") { request.setValue(value, forHTTPHeaderField: key) }
            // Local fixtures are allowed only for an explicitly local configured source.
            var localFixture = false
            #if DEBUG
            localFixture = ProcessInfo.processInfo.environment["OXA_PROVIDER_FIXTURES"] == "1" && endpoint.host == "127.0.0.1" && endpoint.port == 8789 && source.allowHTTP
            #endif
            let payload = try await BoundedHTTP.fetch(request, limit: 2 * 1024 * 1024, allowHTTP: localFixture, publicOnly: !localFixture, crossOrigin: true)
            guard let text = String(data: payload.data, encoding: .utf8) else { throw OxaError.message("The provider requested a non-text response.") }
            var safeHeaders: [String: String] = [:]
            for (key, value) in payload.response.allHeaderFields where ["content-type", "location"].contains(String(describing: key).lowercased()) { safeHeaders[String(describing: key)] = String(describing: value) }
            let answer: [String: Any] = ["id": id, "status": payload.response.statusCode, "headers": safeHeaders, "body": text, "encoding": "utf-8"]
            let data = try await HTTPClient.shared.data(callback, source: source, headers: ["Content-Type": "application/json", "Accept": "application/json"], method: "POST", body: JSONSerialization.data(withJSONObject: answer), publicOnly: !URLPolicy.isLocal(endpoint.host ?? ""), limit: 2 * 1024 * 1024)
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw OxaError.message("The provider returned an invalid response.") }; result = value
        }
        guard result["clientFetch"] == nil else { throw OxaError.message("This server exceeded the provider request limit. Try another server.") }
        return result
    }
}
