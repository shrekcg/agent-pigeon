// swift-tools-version:5.9
// The macOS shell of Agent 信鸽: a menu bar app hosting the web UI and supervising the engine.
// Built by scripts/build-app.sh (`swift build -c release`), no Xcode project needed.
import PackageDescription

let package = Package(
    name: "AgentPigeon",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "AgentPigeon", path: "Sources/AgentPigeon"),
    ]
)
