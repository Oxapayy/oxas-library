import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif

enum M3UParser {
    // NSRegularExpression is immutable and safe to share. Compiling it for every
    // channel made large IPTV imports spend most of their time in the regex compiler.
    private static let attributePattern = try! NSRegularExpression(pattern: #"([\w-]+)\s*=\s*"([^"]*)""#)
    static func attributes(_ line: String) -> [String: String] {
        let ns = line as NSString
        return Dictionary(attributePattern.matches(in: line, range: NSRange(location: 0, length: ns.length)).map {
            (ns.substring(with: $0.range(at: 1)).lowercased(), ns.substring(with: $0.range(at: 2)))
        }, uniquingKeysWith: { _, last in last })
    }
    static func parse(_ text: String, sourceID: UUID, baseURL: URL, maximumChannels: Int = 100_000) throws -> [Media] {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{feff}")))
        guard text.hasPrefix("#EXTM3U") else { throw OxaError.message("This URL did not return an M3U playlist.") }
        guard !text.contains("#EXT-X-TARGETDURATION") && !text.contains("#EXT-X-STREAM-INF") else { throw OxaError.message("This is a video stream. Add it as a Video URL instead of a channel playlist.") }
        var result: [Media] = []
        var info = ""
        var seen: Set<String> = []
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("#EXTINF:") { info = line; continue }
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let url = URL(string: line, relativeTo: baseURL)?.absoluteURL, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { continue }
            let attrs = attributes(info)
            // URL is a stable identity even if the provider changes playlist order.
            let key = attrs["tvg-id"].flatMap { $0.isEmpty ? nil : $0 } ?? url.absoluteString
            guard seen.insert(key).inserted else { info = ""; continue }
            guard result.count < maximumChannels else { throw OxaError.message("This playlist contains too many channels. Add a smaller playlist.") }
            // The EXTINF separator is the first comma outside quoted attributes.
            var quoted = false; var separator: String.Index?
            for index in info.indices { if info[index] == "\"" { quoted.toggle() }; if info[index] == "," && !quoted { separator = index; break } }
            let label = separator.map { String(info[info.index(after: $0)...]).trimmingCharacters(in: .whitespaces) } ?? ""
            var item = Media(id: "\(sourceID):\(key)", sourceID: sourceID, providerID: key, title: label.isEmpty ? (attrs["tvg-name"] ?? url.lastPathComponent) : label, kind: .channel)
            item.stream = url; item.poster = attrs["tvg-logo"].flatMap { URL(string: $0, relativeTo: baseURL)?.absoluteURL }
            item.group = attrs["group-title"]; item.channelID = attrs["tvg-id"]
            result.append(item); info = ""
        }
        guard !result.isEmpty else { throw OxaError.message("The playlist contains no supported HTTP or HTTPS channels.") }
        return result
    }
    static func guideURL(_ text: String, baseURL: URL) -> URL? {
        let firstLine = text.prefix { !$0.isNewline }
        let attrs = attributes(String(firstLine))
        return (attrs["x-tvg-url"] ?? attrs["url-tvg"]).flatMap { URL(string: $0, relativeTo: baseURL)?.absoluteURL }
    }
}
final class XMLTVParser: NSObject, XMLParserDelegate {
    let sourceID: UUID
    private let maximumPrograms: Int
    private var limitExceeded = false
    var programs: [TVProgram] = []
    private var channel = "", title = "", overview = "", field = ""
    private var start: Date?, end: Date?
    private let zonedFormatter = XMLTVParser.formatter("yyyyMMddHHmmss Z")
    private let utcFormatter = XMLTVParser.formatter("yyyyMMddHHmmss")
    init(sourceID: UUID, maximumPrograms: Int = 200_000) { self.sourceID = sourceID; self.maximumPrograms = maximumPrograms }
    private static func formatter(_ pattern: String) -> DateFormatter {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = pattern
        return formatter
    }
    static func date(_ value: String) -> Date? {
        let value = value.trimmingCharacters(in: .whitespaces)
        return formatter(value.contains(" ") ? "yyyyMMddHHmmss Z" : "yyyyMMddHHmmss").date(from: value)
    }
    private func programDate(_ value: String) -> Date? {
        let value = value.trimmingCharacters(in: .whitespaces)
        return (value.contains(" ") ? zonedFormatter : utcFormatter).date(from: value)
    }
    func parse(_ data: Data) throws -> [TVProgram] {
        programs.removeAll(keepingCapacity: true)
        limitExceeded = false
        channel = ""; title = ""; overview = ""; field = ""; start = nil; end = nil
        let parser = XMLParser(data: data); parser.shouldResolveExternalEntities = false; parser.delegate = self
        guard parser.parse() else {
            if limitExceeded { throw OxaError.message("This program guide contains too many entries. Use a smaller guide.") }
            throw OxaError.message("The program guide is not valid XMLTV.")
        }
        return programs
    }
    func parser(_ parser: XMLParser, didStartElement element: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        field = element
        if element == "programme" { channel = attributes["channel"] ?? ""; start = programDate(attributes["start"] ?? ""); end = programDate(attributes["stop"] ?? ""); title = ""; overview = "" }
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) { if field == "title" { title += string }; if field == "desc" { overview += string } }
    func parser(_ parser: XMLParser, didEndElement element: String, namespaceURI: String?, qualifiedName: String?) {
        if element == "programme", let start, let end, end > start, !channel.isEmpty {
            guard programs.count < maximumPrograms else { limitExceeded = true; parser.abortParsing(); return }
            programs.append(TVProgram(id: "\(sourceID):\(channel):\(start.timeIntervalSince1970)", sourceID: sourceID, channelID: channel, title: title.trimmingCharacters(in: .whitespacesAndNewlines), start: start, end: end, overview: overview.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        field = ""
    }
}
struct DAVEntry { var href: String; var name: String; var directory: Bool }
final class DAVParser: NSObject, XMLParserDelegate {
    var entries: [DAVEntry] = []
    private var field = "", href = "", name = "", directory = false
    func parse(_ data: Data) throws -> [DAVEntry] {
        let parser = XMLParser(data: data); parser.shouldProcessNamespaces = true; parser.shouldResolveExternalEntities = false; parser.delegate = self
        guard parser.parse() else { throw OxaError.message("The NAS did not return a valid WebDAV directory.") }; return entries
    }
    func parser(_ parser: XMLParser, didStartElement element: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        field = element
        if element == "response" { href = ""; name = ""; directory = false }
        if element == "collection" { directory = true }
    }
    func parser(_ parser: XMLParser, foundCharacters text: String) { if field == "href" { href += text }; if field == "displayname" { name += text } }
    func parser(_ parser: XMLParser, didEndElement element: String, namespaceURI: String?, qualifiedName: String?) {
        if element == "response" { entries.append(DAVEntry(href: href.trimmingCharacters(in: .whitespacesAndNewlines), name: name.trimmingCharacters(in: .whitespacesAndNewlines), directory: directory)) }; field = ""
    }
}
struct CaptionCue: Hashable { var start: Double; var end: Double; var text: String }
enum CaptionParser {
    static func parse(_ text: String) -> [CaptionCue] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        return normalized.components(separatedBy: "\n\n").compactMap { block in
            let lines = block.components(separatedBy: "\n")
            guard let index = lines.firstIndex(where: { $0.contains("-->") }) else { return nil }
            let times = lines[index].components(separatedBy: "-->")
            guard times.count == 2, let start = time(times[0]), let end = time(times[1]), end > start else { return nil }
            let text = lines.dropFirst(index + 1).joined(separator: "\n").replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            return CaptionCue(start: start, end: end, text: text)
        }
    }
    private static func time(_ value: String) -> Double? {
        guard let first = value.trimmingCharacters(in: .whitespaces).split(separator: " ").first else { return nil }
        let parts = first.replacingOccurrences(of: ",", with: ".").split(separator: ":").compactMap { Double($0) }
        guard parts.count == 2 || parts.count == 3 else { return nil }
        return parts.reversed().enumerated().reduce(0) { $0 + $1.element * pow(60, Double($1.offset)) }
    }
}
