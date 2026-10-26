// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "OxaCore", platforms: [.macOS(.v14)], products: [.library(name: "OxaCore", targets: ["OxaCore"])], targets: [.target(name: "OxaCore"), .testTarget(name: "OxaCoreTests", dependencies: ["OxaCore"])])
