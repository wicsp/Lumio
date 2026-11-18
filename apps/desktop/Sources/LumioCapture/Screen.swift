import AppKit
import ApplicationServices
import ImageIO
import LumioCaptureCore
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

struct ScreenCapture {
    let app: App
    let title: String?
    let url: URL?
    let selected: String?
    let image: CGImage?
    let window: CGRect?
    let captured: Date
    let pointer: CGPoint

    func request(press: Press, includeTrail: Bool) async throws -> (GlanceRequest, Data?) {
        let app = app, title = title, url = url, selected = selected, captured = captured, pointer = pointer
        guard let image, let window else {
            return (GlanceRequest(captured: captured, app: app, window: title, url: url, selection: selected), nil)
        }
        let encoded = try await Task.detached(priority: .userInitiated) {
            try (Self.jpeg(image), Self.recognize(image, window: window))
        }.value
        let transform = PixelTransform(window: window, width: image.width, height: image.height)
        return (GlanceRequest(captured: captured, app: app, window: title, url: url,
                              image: Image(format: "jpeg", width: image.width, height: image.height),
                              pointer: transform.point(pointer), trail: includeTrail ? press.trail(in: transform) : [], selection: selected, ocr: encoded.1), encoded.0)
    }

    @MainActor static func collect(app target: NSRunningApplication, at pointer: CGPoint, hub: Hub) async throws -> ScreenCapture {
        let captured = Date(), bundle = target.bundleIdentifier
        let app = App(bundleID: bundle, name: clippedUTF16(target.localizedName ?? bundle ?? "App", limit: 200))
        let element = AXUIElementCreateApplication(target.processIdentifier)
        let selected = (attribute(element, kAXFocusedUIElementAttribute) as AXUIElement?)
            .flatMap { attribute($0, kAXSelectedTextAttribute) as String? }
            .map { clippedUTF16($0, limit: CaptureLimits.maxSelection) }
            .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let focusedWindow: AXUIElement? = attribute(element, kAXFocusedWindowAttribute)
        let title: String? = focusedWindow.flatMap { attribute($0, kAXTitleAttribute) }
        let ids = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
            .filter {
                ($0[kCGWindowOwnerPID as String] as? pid_t) == target.processIdentifier
                && ($0[kCGWindowLayer as String] as? Int) == 0
            }.compactMap { $0[kCGWindowNumber as String] as? CGWindowID }
        let browser = try await browserURL(bundle, windowTitle: title, focusedWindow: focusedWindow)
        if let browser, hub.isLocal(browser) {
            return ScreenCapture(app: app, title: nil, url: browser, selected: nil, image: nil, window: nil, captured: captured, pointer: pointer)
        }
        guard CGPreflightScreenCaptureAccess() else { throw CaptureFailure("请在系统设置中允许屏幕录制") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = ids.lazy.compactMap({ id in content.windows.first { $0.windowID == id } }).first,
              window.frame.width >= 1, window.frame.height >= 1 else {
            if browser != nil || selected != nil {
                return ScreenCapture(app: app, title: title.map { clippedUTF16($0, limit: CaptureLimits.maxWindowTitle) },
                                     url: browser, selected: selected, image: nil, window: nil, captured: captured, pointer: pointer)
            }
            throw CaptureFailure("找不到可截取的前台窗口")
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = min(CGFloat(filter.pointPixelScale), CGFloat(CaptureLimits.maxImageEdge) / max(window.frame.width, window.frame.height))
        let config = SCStreamConfiguration()
        config.width = max(1, Int(window.frame.width * scale))
        config.height = max(1, Int(window.frame.height * scale))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.capturesAudio = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        return ScreenCapture(app: app, title: (window.title ?? title).map { clippedUTF16($0, limit: CaptureLimits.maxWindowTitle) },
                             url: browser, selected: selected, image: image, window: window.frame, captured: captured, pointer: pointer)
    }

    private static func attribute<T>(_ element: AXUIElement, _ key: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
        return value as? T
    }

    private static func browserURL(_ bundle: String?, windowTitle: String?, focusedWindow: AXUIElement?) async throws -> URL? {
        let script: String
        if bundle == "com.apple.Safari" {
            let description: String? = focusedWindow.flatMap { attribute($0, kAXDescriptionAttribute) }
            let identifiers = [windowTitle, description].compactMap { $0 }.joined(separator: " ").lowercased()
            if ["private browsing", "无痕浏览", "隐私浏览"].contains(where: identifiers.contains) {
                throw CaptureFailure("这个隐私窗口不截取")
            }
            script = #"tell application id "com.apple.Safari" to return URL of current tab of front window"#
        } else {
            guard let chromiumScript = chromiumTabScript(bundle) else { return nil }
            script = chromiumScript
        }
        let raw = await Task.detached(priority: .userInitiated) { () -> String? in
            var error: NSDictionary?
            return NSAppleScript(source: script)?.executeAndReturnError(&error).stringValue
        }.value
        if raw == "__private__" { throw CaptureFailure("这个隐私窗口不截取") }
        guard let raw, raw.utf16.count <= 2048, var parts = URLComponents(string: raw),
              parts.scheme == "http" || parts.scheme == "https", parts.host != nil else { return nil }
        parts.user = nil
        parts.password = nil
        return parts.url
    }

    private static func jpeg(_ image: CGImage) throws -> Data {
        for quality in [0.80, 0.64, 0.48, 0.32] {
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { break }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            if CGImageDestinationFinalize(destination), data.length <= CaptureLimits.maxImageBytes { return data as Data }
        }
        throw CaptureFailure("截图超过 Hub 大小限制")
    }

    private static func recognize(_ image: CGImage, window: CGRect) -> [OCRBlock] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        guard (try? VNImageRequestHandler(cgImage: image).perform([request])) != nil else { return [] }
        let transform = PixelTransform(window: window, width: image.width, height: image.height)
        return orderedOCR((request.results ?? []).compactMap {
            guard let candidate = $0.topCandidates(1).first, let box = transform.visionBox($0.boundingBox) else { return nil }
            return OCRBlock(text: candidate.string, box: box, confidence: Double(candidate.confidence))
        })
    }
}
