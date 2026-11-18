import CoreGraphics
import Foundation

public enum CaptureLimits {
    public static let tapSeconds = 0.250
    public static let sampleSeconds = 0.05
    public static let maxTrailPoints = 200
    public static let maxImageEdge = 2048
    public static let maxImageBytes = 4 * 1024 * 1024
    public static let maxSelection = 20_000
    public static let maxOCRBlocks = 2000
    public static let maxOCRText = 100_000
    public static let maxWindowTitle = 500
}

public enum Trigger: Equatable, Codable {
    case key(Int)
    case mouse(Int)

    public static let defaultKey = Self.key(79) // F18
    public var display: String {
        switch self {
        case .key(79): return "F18"
        case .key(let code): return "Key \(code)"
        case .mouse(let button): return "Mouse \(button + 1)"
        }
    }
}

public struct PixelPoint: Codable, Equatable {
    public let x: Int, y: Int
    public init(x: Int, y: Int) { self.x = x; self.y = y }
}

public struct TrailPoint: Codable, Equatable {
    public let x: Int, y: Int, t_ms: Int
    public init(_ point: PixelPoint, milliseconds: Int) {
        x = point.x; y = point.y; t_ms = milliseconds
    }
}

public struct PixelBox: Codable, Equatable {
    public let x: Int, y: Int, w: Int, h: Int
    public init(x: Int, y: Int, w: Int, h: Int) { self.x = x; self.y = y; self.w = w; self.h = h }
}

public struct OCRBlock: Codable, Equatable {
    public let text: String, box: PixelBox, confidence: Double?
    public init(text: String, box: PixelBox, confidence: Double? = nil) {
        self.text = text; self.box = box; self.confidence = confidence
    }
}

public struct App: Codable {
    public let bundle_id: String?
    public let name: String
    public init(bundleID: String?, name: String) {
        bundle_id = bundleID; self.name = name
    }
}

public struct Image: Codable {
    public let format: String
    public let width: Int, height: Int
    public init(format: String, width: Int, height: Int) {
        self.format = format; self.width = width; self.height = height
    }
}

public struct BrowserPage: Decodable {
    public enum Format: String, Codable { case html, text }
    public struct Metadata: Codable {
        public let format: Format
        public let title: String?
    }
    public let url: URL
    public let format: Format
    public let title: String?
    public let body: String
    public var metadata: Metadata { Metadata(format: format, title: title) }
    public var isValid: Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              ["http", "https"].contains(parts.scheme ?? ""), parts.host != nil,
              parts.user == nil, parts.password == nil, url.absoluteString.utf16.count <= 2048 else { return false }
        if let title, title.isEmpty || title.utf16.count > 500 { return false }
        return body.utf16.count <= 2_000_000 && body.utf8.count <= 6 * 1024 * 1024
            && !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

public struct GlanceRequest: Codable {
    public let request_id: String, captured: String, app: App
    public var window_title: String?, url: URL?, image: Image?, pointer: PixelPoint?
    public var trail: [TrailPoint], selection_text: String?, ocr: [OCRBlock], ocr_engine: String?
    public var page: BrowserPage.Metadata?

    public init(requestID: String = UUID().uuidString, captured: Date, app: App, window: String? = nil, url: URL? = nil,
                image: Image? = nil, pointer: PixelPoint? = nil, trail: [TrailPoint] = [], selection: String? = nil, ocr: [OCRBlock] = []) {
        request_id = requestID
        self.captured = ISO8601DateFormatter().string(from: captured)
        self.app = app; window_title = window; self.url = url
        self.image = image; self.pointer = pointer; self.trail = trail
        selection_text = selection; self.ocr = ocr
        ocr_engine = ocr.isEmpty ? nil : "apple-vision@1"
    }

    public func multipart(boundary: String, screenshot: Data?, pageContent: String? = nil) throws -> Data {
        var body = Data()
        func append(_ text: String) { body.append(contentsOf: text.utf8) }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n")
        body.append(try JSONEncoder().encode(self))
        if let screenshot, let image {
            append("\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"image\"; filename=\"window.\(image.format)\"\r\nContent-Type: image/\(image.format)\r\n\r\n")
            body.append(screenshot)
        }
        if let pageContent, page != nil {
            append("\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"page\"; filename=\"page\"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n")
            append(pageContent)
        }
        append("\r\n--\(boundary)--\r\n")
        return body
    }
}

public struct CaptureRequest: Codable {
    public let request_id: String, channel = "desktop", glance: String
    public init(glance: String, requestID: String = UUID().uuidString) {
        request_id = requestID; self.glance = glance
    }
    private enum CodingKeys: String, CodingKey { case request_id, channel, glance }
}

public struct ChatRequest: Codable {
    public let request_id: String, conversation: String, message: String, glance: String
    public let record_idea: Bool?
    public init(conversation: String, message: String, glance: String, requestID: String = UUID().uuidString, recordIdea: Bool? = nil) {
        request_id = requestID; self.conversation = conversation; self.message = message; self.glance = glance; record_idea = recordIdea
    }
}

public struct PixelTransform {
    public let window: CGRect
    public let width: Int, height: Int
    public init(window: CGRect, width: Int, height: Int) {
        self.window = window; self.width = width; self.height = height
    }

    public func point(_ location: CGPoint) -> PixelPoint? {
        guard window.width > 0, window.height > 0, window.contains(location), width > 0, height > 0 else { return nil }
        return PixelPoint(
            x: min(width - 1, Int((location.x - window.minX) / window.width * CGFloat(width))),
            y: min(height - 1, Int((location.y - window.minY) / window.height * CGFloat(height)))
        )
    }

    public func visionBox(_ normalized: CGRect) -> PixelBox? {
        guard width > 0, height > 0 else { return nil }
        let clipped = normalized.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        guard !clipped.isEmpty else { return nil }
        let x = Int(clipped.minX * CGFloat(width)), y = Int((1 - clipped.maxY) * CGFloat(height))
        let maxX = min(width, Int((clipped.maxX * CGFloat(width)).rounded(.up)))
        let maxY = min(height, Int(((1 - clipped.minY) * CGFloat(height)).rounded(.up)))
        return PixelBox(x: x, y: y, w: maxX - x, h: maxY - y)
    }
}

public struct Press {
    public let started: TimeInterval
    private var samples: [(point: CGPoint, seconds: TimeInterval)] = []
    private var spacing = CaptureLimits.sampleSeconds
    public init(started: TimeInterval) { self.started = started }

    public func isTap(at end: TimeInterval) -> Bool { end - started < CaptureLimits.tapSeconds }
    public mutating func add(_ point: CGPoint, at time: TimeInterval) {
        guard time - (samples.last?.seconds ?? (started - spacing)) >= spacing - 0.000_1 else { return }
        if samples.count == CaptureLimits.maxTrailPoints * 2 {
            samples = samples.enumerated().compactMap { $0.offset.isMultiple(of: 2) ? $0.element : nil }
            spacing *= 2
        }
        samples.append((point, time))
    }

    public func trail(in transform: PixelTransform) -> [TrailPoint] {
        let input = samples.compactMap { sample in
            transform.point(sample.point).map { TrailPoint($0, milliseconds: max(0, Int((sample.seconds - started) * 1000))) }
        }
        guard input.count > CaptureLimits.maxTrailPoints else { return input }
        return (0..<CaptureLimits.maxTrailPoints).map { index in input[index * (input.count - 1) / (CaptureLimits.maxTrailPoints - 1)] }
    }
}

public func clippedUTF16(_ text: String, limit: Int) -> String {
    var length = 0, result = ""
    for character in text {
        length += character.utf16.count
        if length > limit { return result }
        result.append(character)
    }
    return result
}

public func orderedOCR(_ blocks: [OCRBlock]) -> [OCRBlock] {
    var remaining = CaptureLimits.maxOCRText
    return blocks.sorted { ($0.box.y, $0.box.x) < ($1.box.y, $1.box.x) }.prefix(CaptureLimits.maxOCRBlocks).compactMap { block in
        let text = clippedUTF16(block.text, limit: min(5000, remaining))
        guard !text.isEmpty else { return nil }
        remaining -= text.utf16.count
        return OCRBlock(text: text, box: block.box, confidence: block.confidence)
    }
}
