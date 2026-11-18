// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LumioCapture",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "LumioCapture", targets: ["LumioCapture"])],
    targets: [
        .target(name: "LumioCaptureCore"),
        .executableTarget(name: "LumioCapture", dependencies: ["LumioCaptureCore"]),
        .testTarget(name: "LumioCaptureCoreTests", dependencies: ["LumioCaptureCore"]),
        .testTarget(name: "LumioCaptureTests", dependencies: ["LumioCapture"]),
    ]
)
