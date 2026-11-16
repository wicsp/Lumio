import Foundation

public enum SpeechPCM {
    public static let sampleRate: Double = 16_000
    public static let frameLimit = 8192

    public static func removeFrame(from buffer: inout Data) -> Data {
        let length = min(buffer.count / 2 * 2, frameLimit)
        let frame = Data(buffer.prefix(length))
        buffer.removeFirst(length)
        return frame
    }
}

public struct SpeechStartFrame: Encodable {
    public let type = "start", protocolVersion = 1, format = "pcm16le-16k-mono"
    public let token: String, requestID: String
    public let vocabulary = true

    public init(token: String, requestID: String = UUID().uuidString) {
        self.token = token
        self.requestID = requestID
    }

    enum CodingKeys: String, CodingKey {
        case type, token, format, vocabulary
        case protocolVersion = "protocol"
        case requestID = "request_id"
    }
}

public struct SpeechControlFrame: Encodable {
    public let type: String
    public init(type: String) { self.type = type }
}

public struct SpeechReplyFrame: Decodable {
    public struct Failure: Decodable { public let message: String }
    public let type: String
    public let text: String?
    public let error: Failure?
}
