import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Darwin)
import Darwin
#endif

/// Bounds bytes before buffering and keeps each request's credentials/cookies isolated.
struct HTTPPayload { var data: Data; var response: HTTPURLResponse }
enum NetworkPolicy {
    static func isPublicAddress(_ address: String) -> Bool {
        let h = address.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h.contains(":") {
            if h.hasPrefix("::ffff:") { return isPublicAddress(String(h.dropFirst(7))) }
            guard let first = h.split(separator: ":").first, let prefix = UInt16(first, radix: 16), (0x2000...0x3fff).contains(prefix) else { return false }
            return !h.hasPrefix("2001:db8:") && !h.hasPrefix("2001:0:") && !h.hasPrefix("2002:")
        }
        let parts = h.split(separator: ".", omittingEmptySubsequences: false).compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        let a = parts[0], b = parts[1]
        return !(a == 0 || a == 10 || a == 127 || a >= 224 || a == 169 && b == 254 || a == 172 && (16...31).contains(b) || a == 192 && (b == 168 || b == 0 || b == 2) || a == 100 && (64...127).contains(b) || a == 198 && (b == 18 || b == 19 || b == 51) || a == 203 && b == 0)
    }
    static func validate(_ url: URL, allowHTTP: Bool, publicOnly: Bool, allowPublicHTTP: Bool = false) async throws {
        if !(allowPublicHTTP && url.scheme == "http") { _ = try URLPolicy.validate(url.absoluteString, allowHTTP: allowHTTP) }
        else { var secure = URLComponents(url: url, resolvingAgainstBaseURL: true)!; secure.scheme = "https"; _ = try URLPolicy.validate(secure.url!.absoluteString, allowHTTP: false) }
        guard publicOnly else { return }
        guard (url.scheme == "https" || allowPublicHTTP && url.scheme == "http"), let host = url.host, !URLPolicy.isLocal(host) else { throw OxaError.message("This provider requested a private or insecure network address.") }
        let addresses: [String] = try await Task.detached {
            var result: UnsafeMutablePointer<addrinfo>?
            guard getaddrinfo(host, nil, nil, &result) == 0, let first = result else { throw OxaError.message("The provider hostname could not be resolved.") }
            defer { freeaddrinfo(first) }
            var values: [String] = []; var current: UnsafeMutablePointer<addrinfo>? = first
            while let entry = current {
                var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(entry.pointee.ai_addr, entry.pointee.ai_addrlen, &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) == 0 { values.append(String(cString: name)) }
                current = entry.pointee.ai_next
            }
            return values
        }.value
        guard !addresses.isEmpty, addresses.allSatisfy(isPublicAddress) else { throw OxaError.message("This provider hostname resolves to a private or reserved network address.") }
    }
}
private final class RedirectDecision: @unchecked Sendable {
    let call: (URLRequest?) -> Void
    init(_ call: @escaping (URLRequest?) -> Void) { self.call = call }
}
final class BoundedHTTP: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let limit: Int, allowHTTP: Bool, publicOnly: Bool, crossOrigin: Bool, allowPublicHTTP: Bool
    private let lock = NSLock()
    private var continuation: CheckedContinuation<HTTPPayload, Error>?
    private var finished = false, cancelled = false
    private var data = Data(), response: HTTPURLResponse?, initial: URL?, redirectCount = 0
    private var session: URLSession?
    init(limit: Int, allowHTTP: Bool, publicOnly: Bool, crossOrigin: Bool, allowPublicHTTP: Bool) { self.allowPublicHTTP = allowPublicHTTP; self.limit = limit; self.allowHTTP = allowHTTP; self.publicOnly = publicOnly; self.crossOrigin = crossOrigin }
    static func fetch(_ request: URLRequest, limit: Int = 64 * 1024 * 1024, allowHTTP: Bool = false, publicOnly: Bool = false, crossOrigin: Bool = false, allowPublicHTTP: Bool = false) async throws -> HTTPPayload {
        guard let url = request.url else { throw URLError(.badURL) }
        try await NetworkPolicy.validate(url, allowHTTP: allowHTTP, publicOnly: publicOnly, allowPublicHTTP: allowPublicHTTP)
        try Task.checkCancellation()
        let transport = BoundedHTTP(limit: limit, allowHTTP: allowHTTP, publicOnly: publicOnly, crossOrigin: crossOrigin, allowPublicHTTP: allowPublicHTTP)
        return try await withTaskCancellationHandler { try await transport.run(request) } onCancel: { transport.cancel() }
    }
    private func run(_ request: URLRequest) async throws -> HTTPPayload {
        try await withCheckedThrowingContinuation { cont in
            lock.lock(); continuation = cont
            let wasCancelled = cancelled; lock.unlock()
            if wasCancelled { finish(.failure(CancellationError())); return }
            let config = URLSessionConfiguration.ephemeral
            config.httpShouldSetCookies = false; config.httpCookieAcceptPolicy = .never; config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 120
            initial = request.url
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil); self.session = session
            session.dataTask(with: request).resume()
            lock.lock(); let cancelNow = cancelled; lock.unlock()
            if cancelNow { cancel() }
        }
    }
    private func cancel() { lock.lock(); cancelled = true; let active = session; lock.unlock(); active?.invalidateAndCancel(); finish(.failure(CancellationError())) }
    private func finish(_ result: Result<HTTPPayload, Error>) {
        lock.lock(); guard !finished, let cont = continuation else { lock.unlock(); return }; finished = true; continuation = nil; lock.unlock()
        cont.resume(with: result); session?.invalidateAndCancel()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else { finish(.failure(URLError(.badServerResponse))); completionHandler(.cancel); return }
        guard dataTask.originalRequest?.httpMethod == "HEAD" || response.expectedContentLength <= Int64(limit) else { finish(.failure(OxaError.message("The server response exceeds the size limit."))); completionHandler(.cancel); return }
        self.response = http; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard chunk.count <= limit - data.count else { finish(.failure(OxaError.message("The server response exceeds the size limit."))); dataTask.cancel(); return }
        data.append(chunk)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(error)) }
        else if let response { finish(.success(HTTPPayload(data: data, response: response))) }
        else { finish(.failure(URLError(.badServerResponse))) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        redirectCount += 1
        guard redirectCount <= 4, let initial, let target = request.url, crossOrigin || URLPolicy.sameOrigin(initial, target) else { completionHandler(nil); return }
        let decision = RedirectDecision(completionHandler)
        Task {
            do {
                try await NetworkPolicy.validate(target, allowHTTP: allowHTTP, publicOnly: publicOnly, allowPublicHTTP: allowPublicHTTP)
                var safe = request
                if !URLPolicy.sameOrigin(initial, target) {
                    safe.setValue(nil, forHTTPHeaderField: "Authorization"); safe.setValue(nil, forHTTPHeaderField: "Cookie")
                    safe.setValue(nil, forHTTPHeaderField: "Referer"); safe.setValue(nil, forHTTPHeaderField: "Origin")
                }
                decision.call(safe)
            } catch { decision.call(nil) }
        }
    }
}
