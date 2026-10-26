import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
func color(_ hex: Int) -> NSColor { NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1) }
func polygon(_ points: [NSPoint], _ fill: NSColor) {
    let path = NSBezierPath(); path.move(to: points[0]); for point in points.dropFirst() { path.line(to: point) }; path.close(); fill.setFill(); path.fill()
}
func image(_ width: Int, _ height: Int, draw: () -> Void) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep); draw(); NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}
func text(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat, face: String = "HelveticaNeue-Medium", ink: NSColor = .white, height: CGFloat = 240) {
    (text as NSString).draw(in: NSRect(x: x, y: y, width: width, height: height), withAttributes: [.font: NSFont(name: face, size: size) ?? .systemFont(ofSize: size), .foregroundColor: ink])
}
let arts: [(String, String, Int, Int)] = [("preview-series", "The Quiet\nCoast", 0x244449, 0x88A5A4), ("preview-film1", "After\nthe Rain", 0x293B36, 0x6D8E7E), ("preview-film2", "A Place\nApart", 0x4A3935, 0xB59D84), ("preview-film3", "Northern\nLight", 0x263641, 0x9DAEB1)]
for (index, art) in arts.enumerated() {
    let data = image(800, 1200) {
        color(art.2).setFill(); NSRect(x: 0, y: 0, width: 800, height: 1200).fill()
        if index == 0 {
            for row in 0..<18 { color(row % 3 == 0 ? 0x627F7F : 0x3D5D60).setFill(); NSRect(x: 0, y: CGFloat(row * 18), width: 800, height: 5).fill() }
            polygon([.init(x: 0, y: 400), .init(x: 250, y: 560), .init(x: 400, y: 520), .init(x: 560, y: 250), .init(x: 800, y: 100), .init(x: 800, y: 0), .init(x: 0, y: 0)], color(0x152D2E))
            polygon([.init(x: 250, y: 520), .init(x: 290, y: 600), .init(x: 330, y: 590), .init(x: 360, y: 510)], color(art.3))
        } else if index == 1 {
            for column in 0..<10 { let h = CGFloat(120 + (column * 73) % 260); color(column % 2 == 0 ? 0x182C27 : 0x354D41).setFill(); NSRect(x: CGFloat(column * 82), y: 0, width: 68, height: h).fill() }
            for drop in 0..<55 { let x = CGFloat((drop * 137) % 800); let y = CGFloat((drop * 93) % 650); color(art.3).setFill(); NSRect(x: x, y: y, width: 2, height: 45).fill() }
        } else {
            polygon([.init(x: 0, y: 0), .init(x: 0, y: 300), .init(x: 310, y: 630), .init(x: 680, y: 0)], color(art.3))
            polygon([.init(x: 100, y: 0), .init(x: 620, y: 540), .init(x: 800, y: 360), .init(x: 800, y: 0)], color(index == 2 ? 0x6D5850 : 0x526977))
            polygon([.init(x: 0, y: 0), .init(x: 470, y: 260), .init(x: 800, y: 120), .init(x: 800, y: 0)], color(index == 2 ? 0x322B29 : 0x192B34))
        }
        text(art.1, x: 62, y: 820, width: 700, size: 85, face: "NewYork-Regular")
        text(index == 0 ? "A SERIES IN SIX CHAPTERS" : "A FILM FROM YOUR COLLECTION", x: 65, y: 710, width: 680, size: 19, ink: color(0xD9E1DF), height: 40)
    }
    let folder = root.appendingPathComponent("Resources/Assets.xcassets/\(art.0).imageset")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try data.write(to: folder.appendingPathComponent("art.png"))
    try Data("{\"images\":[{\"filename\":\"art.png\",\"idiom\":\"universal\"}],\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to: folder.appendingPathComponent("Contents.json"))
}
let icon = image(1024, 1024) {
    NSColor.black.setFill(); NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
    let circle = NSBezierPath(ovalIn: NSRect(x: 218, y: 218, width: 588, height: 588)); circle.lineWidth = 42; NSColor.white.setStroke(); circle.stroke()
    polygon([.init(x: 445, y: 355), .init(x: 445, y: 669), .init(x: 656, y: 512)], .white)
}
try icon.write(to: root.appendingPathComponent("Resources/Assets.xcassets/AppIcon.appiconset/Icon.png"))
try Data("{\"images\":[{\"filename\":\"Icon.png\",\"idiom\":\"universal\",\"platform\":\"ios\",\"size\":\"1024x1024\"}],\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to: root.appendingPathComponent("Resources/Assets.xcassets/AppIcon.appiconset/Contents.json"))
let launch = root.appendingPathComponent("Resources/Assets.xcassets/LaunchBackground.colorset"); try FileManager.default.createDirectory(at: launch, withIntermediateDirectories: true)
try Data("{\"colors\":[{\"idiom\":\"universal\",\"color\":{\"color-space\":\"srgb\",\"components\":{\"red\":\"0.000\",\"green\":\"0.000\",\"blue\":\"0.000\",\"alpha\":\"1.000\"}}}],\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to: launch.appendingPathComponent("Contents.json"))
