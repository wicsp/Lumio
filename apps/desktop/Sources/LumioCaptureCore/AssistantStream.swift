import Foundation

public struct AssistantStream {
    private struct Event: Decodable {
        struct Notice: Decodable { let source: String }
        struct Message: Decodable { let role: String; let content: String }
        struct Tool: Decodable {
            struct Result: Decodable { let kind: String?; let status: String? }
            let result: Result?
            enum CodingKeys: CodingKey { case result }
            init(from decoder: Decoder) throws {
                // A workbench UI event carries the tool ID, while a tool event carries its result.
                if (try? decoder.singleValueContainer().decode(String.self)) != nil {
                    result = nil
                    return
                }
                let container = try decoder.container(keyedBy: CodingKeys.self)
                result = try? container.decode(Result.self, forKey: .result)
            }
        }

        let type: String
        let delta: String?
        let idea: String?
        let notice: Notice?
        let tool: Tool?
        let messages: [Message]?
        let error: String?
    }

    public private(set) var idea: String?
    public private(set) var reply = ""
    public private(set) var needsApproval = false
    public private(set) var finished = false
    public init() {}

    public mutating func read(_ line: String) throws -> Bool {
        let event = try JSONDecoder().decode(Event.self, from: Data(line.utf8))
        switch event.type {
        case "idea_saved":
            idea = event.idea
            return idea != nil
        case "token":
            reply += event.delta ?? ""
            return true
        case "notice" where event.notice?.source == "proposal",
             "tool" where event.tool?.result?.kind == "proposal" || event.tool?.result?.status == "pending":
            needsApproval = true
            return true
        case "result":
            let final = (event.messages ?? []).filter { $0.role == "assistant" && !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                .map(\.content).joined(separator: "\n\n")
            if !final.isEmpty { reply = final }
            finished = true
            return true
        case "error":
            throw StreamFailure(message: event.error ?? "助手请求失败")
        default: return false
        }
    }

    public struct StreamFailure: LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }
}
