import Foundation
import LumioCaptureCore
import Security

struct CaptureFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum CredentialStore {
    private static let account: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "io.lumio.capture",
        kSecAttrAccount as String: "hub",
    ]

    static func read(account name: String = "hub") -> String? {
        var result: CFTypeRef?
        var query = account
        query[kSecAttrAccount as String] = name
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ token: String, account name: String = "hub") throws {
        let data = Data(token.utf8)
        var query = account
        query[kSecAttrAccount as String] = name
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let added = SecItemAdd(query as CFDictionary, nil)
        let match = account.merging([kSecAttrAccount as String: name]) { _, value in value }
        let status = added == errSecDuplicateItem ? SecItemUpdate(match as CFDictionary, [kSecValueData as String: data] as CFDictionary) : added
        guard status == errSecSuccess else { throw CaptureFailure("无法写入钥匙串（\(status)）") }
    }

    static func remove(account name: String = "hub") throws {
        let match = account.merging([kSecAttrAccount as String: name]) { _, value in value }
        let status = SecItemDelete(match as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CaptureFailure("无法清除钥匙串凭据（\(status)）") }
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct Hub {
    struct Glance: Decodable { let id: String }
    private struct Join: Decodable { let token: String }
    private struct JoinRequest: Encodable { let code: String }
    private struct ErrorResponse: Decodable {
        struct Detail: Decodable { let message: String }
        let error: Detail
    }
    private struct CaptureResult: Decodable {
        struct Capture: Decodable {
            let id: String
            let title: String?
            let state: String
            let error: ErrorResponse.Detail?
        }
        let capture: Capture
    }

    let origin: URL
    let token: String?
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.httpShouldSetCookies = false
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }()

    static func origin(from value: String) throws -> URL {
        guard var parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/" else {
            throw CaptureFailure("请输入 Hub 的完整网址")
        }
        guard parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else {
            throw CaptureFailure("远程 Hub 需要 HTTPS")
        }
        parts.path = ""
        guard let result = parts.url else { throw CaptureFailure("Hub 网址无效") }
        return result
    }

    func isLocal(_ url: URL) -> Bool {
        func port(_ value: URL) -> Int { value.port ?? (value.scheme == "https" ? 443 : 80) }
        return url.scheme == origin.scheme && url.host?.lowercased() == origin.host?.lowercased() && port(url) == port(origin)
    }

    func request(_ path: String, method: String, body: Data? = nil, contentType: String = "application/json") -> URLRequest {
        var request = URLRequest(url: origin.appendingPathComponent(path))
        request.httpMethod = method
        request.httpBody = body
        request.setValue("zh", forHTTPHeaderField: "Accept-Language")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await Self.session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw CaptureFailure("Hub 响应无效") }
        if (200..<300).contains(response.statusCode) { return data }
        let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error.message
        throw CaptureFailure(message ?? "Hub 请求失败（\(response.statusCode)）")
    }

    func ping() async throws { _ = try await send(request("health", method: "GET")) }
    func pair(code: String) async throws -> String {
        let data = try await send(request("v2/setup/client/join", method: "POST", body: JSONEncoder().encode(JoinRequest(code: code))))
        return try JSONDecoder().decode(Join.self, from: data).token
    }

    func upload(_ meta: GlanceRequest, image: Data?, page: BrowserPage? = nil) async throws -> Glance {
        let boundary = "Lumio-\(UUID())"
        var meta = meta
        meta.page = page?.metadata
        let body = try meta.multipart(boundary: boundary, screenshot: image, pageContent: page?.body)
        let data = try await send(request("v2/glances", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)"))
        return try JSONDecoder().decode(Glance.self, from: data)
    }

    func save(_ glance: Glance, waitForPage: Bool = false) async throws -> (title: String, ready: Bool) {
        let body = try JSONEncoder().encode(CaptureRequest(glance: glance.id))
        let data = try await send(request("v2/inbox/captures", method: "POST", body: body))
        var capture = try JSONDecoder().decode(CaptureResult.self, from: data).capture
        guard waitForPage else { return (capture.title ?? "所见", true) }
        for _ in 0..<12 {
            if capture.state == "ready" { return (capture.title ?? "所见", true) }
            if capture.state == "failed" { throw CaptureFailure(capture.error?.message ?? "正文入库失败") }
            try await Task.sleep(for: .milliseconds(250))
            let status = try await send(request("v2/inbox/captures/\(capture.id)", method: "GET"))
            capture = try JSONDecoder().decode(CaptureResult.Capture.self, from: status)
        }
        if capture.state == "failed" { throw CaptureFailure(capture.error?.message ?? "正文入库失败") }
        return (capture.title ?? "所见", capture.state == "ready")
    }

    func mainConversation() async throws -> String {
        struct Input: Encodable { let request_id = UUID().uuidString }
        struct Result: Decodable { let conversation: String }
        let data = try await send(request("v2/assistant/main", method: "POST", body: JSONEncoder().encode(Input())))
        return try JSONDecoder().decode(Result.self, from: data).conversation
    }

    @MainActor func chat(_ input: ChatRequest, update: (AssistantStream) -> Void) async throws {
        var query = request("v2/assistant/chat", method: "POST", body: try JSONEncoder().encode(input))
        query.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        query.timeoutInterval = 130
        let (bytes, response) = try await Self.session.bytes(for: query)
        guard let response = response as? HTTPURLResponse else { throw CaptureFailure("Hub 响应无效") }
        if !(200..<300).contains(response.statusCode) {
            var data = Data()
            for try await byte in bytes.prefix(65_536) { data.append(byte) }
            let detail = try? JSONDecoder().decode(ErrorResponse.self, from: data)
            throw CaptureFailure(detail?.error.message ?? "助手请求失败（\(response.statusCode)）")
        }
        var state = AssistantStream()
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if try state.read(line) { update(state) }
            if state.finished { return }
        }
        throw CaptureFailure("助手回复中断")
    }

    func noteURL(_ idea: String) -> URL {
        guard var address = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return origin }
        address.fragment = "knowledge/\(idea)"
        return address.url ?? origin
    }

    func conversationURL(_ conversation: String) -> URL {
        guard var address = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return origin }
        address.fragment = "assistant/\(conversation)"
        return address.url ?? origin
    }

    func discard(_ glance: Glance) async throws { _ = try await send(request("v2/glances/\(glance.id)", method: "DELETE")) }
}
