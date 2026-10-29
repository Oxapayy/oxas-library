import XCTest
@testable import OxasLibrary

final class UpdateCheckTests: XCTestCase {
    func testVersionsCompareNumerically() {
        XCTAssertTrue(UpdateCheck.newer("1.3.10", than: "1.3.9"))
        XCTAssertFalse(UpdateCheck.newer("1.3.2", than: "1.3.2"))
        XCTAssertFalse(UpdateCheck.newer("1.3.1", than: "1.3.2"))
        XCTAssertTrue(UpdateCheck.newer("2.0", than: "1.9.9"))
    }

    func testPicksNewestPublishedIOSReleaseWithIPA() throws {
        func release(_ tag: String, _ assets: [String], prerelease: Bool = false) -> [String: Any] {
            ["tag_name": tag, "prerelease": prerelease, "html_url": "https://github.com/x/\(tag)", "assets": assets.map { ["name": $0] }]
        }
        let data = try JSONSerialization.data(withJSONObject: [
            release("desktop-v2.0.0", ["Oxa-Library-Setup-2.0.0.exe"]),
            release("v1.5.0", ["Oxas-Library-v1.5.0-iOS-unsigned.ipa"], prerelease: true),
            release("v1.4.0", ["Oxas-Library-v1.4.0-iOS-unsigned.ipa", "SHA256SUMS"]),
            release("v1.3.9", ["Oxas-Library-v1.3.9-iOS-unsigned.ipa"]),
            release("v1.4.1", ["notes.txt"]),
        ])
        XCTAssertEqual(UpdateCheck.pick(data, current: "1.3.2"), AppRelease(version: "1.4.0", page: URL(string: "https://github.com/x/v1.4.0")!))
        XCTAssertNil(UpdateCheck.pick(data, current: "1.4.0"))
        XCTAssertNil(UpdateCheck.pick(Data("not json".utf8), current: "1.0.0"))
    }
}
