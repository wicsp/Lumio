import CryptoKit
import Foundation
import LumioCaptureCore
import Network
import Security

@MainActor final class BrowserBridge {
    static let port: NWEndpoint.Port = 7421

    private struct Incoming: Decodable {
        let type: String
        var proof: String?
        var id: String?
        var page: BrowserPage?
    }
    private struct Outgoing: Encodable {
        let type: String
        var nonce: String?
        var proof: String?
        var id: String?
        var expires: Int64?
    }
    private struct Pending {
        let id: String
        let result: CheckedContinuation<BrowserPage?, Never>
        let timeout: Task<Void, Never>
    }

    private var listener: NWListener?
    private var peer: NWConnection?
    private var pending: Pending?
    private var authenticated = false
    private(set) var browser: String?

    var connected: Bool { authenticated }

    static func key() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw CaptureFailure("无法生成浏览器配对密钥")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func extensionID(_ value: String) -> Bool {
        value.utf8.count == 32 && value.utf8.allSatisfy { (97...112).contains($0) }
    }

    func start(extensionID: String, browser: String, secret: String) throws {
        stop()
        let key = SymmetricKey(data: Data(secret.utf8))
        let origin = "chrome-extension://\(extensionID)"
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        // JSON escaping can require up to six bytes for a UTF-16 code unit.
        websocket.maximumMessageSize = 13 * 1024 * 1024
        websocket.setClientRequestHandler(.main) { _, headers in
            let origins = headers.filter { $0.name.caseInsensitiveCompare("Origin") == .orderedSame }
            return .init(status: origins.count == 1 && origins[0].value == origin ? .accept : .reject, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: Self.port)
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        let listener = try NWListener(using: parameters)
        self.browser = browser
        self.listener = listener
        listener.newConnectionHandler = { [weak self, weak listener] connection in
            MainActor.assumeIsolated {
                guard let self, let listener, self.listener === listener else { connection.cancel(); return }
                self.accept(connection, key: key)
            }
        }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            MainActor.assumeIsolated {
                if case .failed = state, let self, let listener, self.listener === listener { self.stop() }
            }
        }
        listener.start(queue: .main)
    }

    func stop() {
        let current = listener
        listener = nil
        current?.cancel()
        if let peer { disconnect(peer) }
        browser = nil
    }

    private func accept(_ connection: NWConnection, key: SymmetricKey) {
        guard peer == nil else { connection.cancel(); return }
        peer = connection
        let nonce = UUID().uuidString.lowercased()
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            MainActor.assumeIsolated {
                guard let self, let connection, self.peer === connection else { return }
                switch state {
                case .ready:
                    self.send(Outgoing(type: "challenge", nonce: nonce), to: connection)
                    self.receive(connection, key: key, nonce: nonce, stage: 0)
                case .failed, .cancelled: self.disconnect(connection)
                default: break
                }
            }
        }
        connection.start(queue: .main)
        Task { [weak self, weak connection] in
            try? await Task.sleep(for: .seconds(3))
            if let self, let connection, self.peer === connection, !self.authenticated { self.disconnect(connection) }
        }
    }

    private func receive(_ connection: NWConnection, key: SymmetricKey, nonce: String, stage: Int) {
        connection.receiveMessage { [weak self, weak connection] data, _, _, error in
            MainActor.assumeIsolated {
                guard let self, let connection, self.peer === connection else { return }
                guard error == nil, let data, let message = try? JSONDecoder().decode(Incoming.self, from: data) else {
                    self.disconnect(connection)
                    return
                }
                switch (stage, message.type) {
                case (0, "proof"):
                    // Compare the fixed-size MAC using CryptoKit's constant-time check.
                    guard let proof = message.proof.flatMap({ Data(base64Encoded: $0) }),
                          HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: Data("extension:\(nonce)".utf8), using: key) else {
                        self.disconnect(connection)
                        return
                    }
                    let proofData = Data(HMAC<SHA256>.authenticationCode(for: Data("desktop:\(nonce)".utf8), using: key))
                    self.send(Outgoing(type: "ready", proof: proofData.base64EncodedString()), to: connection)
                    self.receive(connection, key: key, nonce: nonce, stage: 1)
                case (1, "ready"):
                    self.authenticated = true
                    self.receive(connection, key: key, nonce: nonce, stage: 2)
                case (2, "page"):
                    if let current = self.pending, message.id == current.id {
                        let page = message.page
                        self.resolve(page?.isValid == true ? page : nil)
                    }
                    self.receive(connection, key: key, nonce: nonce, stage: 2)
                case (2, "keepalive"):
                    self.receive(connection, key: key, nonce: nonce, stage: 2)
                default: self.disconnect(connection)
                }
            }
        }
    }

    private func send(_ value: Outgoing, to connection: NWConnection) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        let context = NWConnection.ContentContext(identifier: "lumio",
            metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }

    private func resolve(_ page: BrowserPage?) {
        guard let current = pending else { return }
        pending = nil
        current.timeout.cancel()
        current.result.resume(returning: page)
    }

    private func disconnect(_ connection: NWConnection) {
        guard peer === connection else { return }
        peer = nil
        authenticated = false
        connection.cancel()
        resolve(nil)
    }

    func capture(bundle: String?) async -> BrowserPage? {
        guard let bundle, bundle == browser, authenticated, let peer, pending == nil, !Task.isCancelled else { return nil }
        let id = UUID().uuidString
        return await withTaskCancellationHandler {
            await withCheckedContinuation { result in
                let timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .milliseconds(800)) } catch { return }
                    if self?.pending?.id == id { self?.resolve(nil) }
                }
                pending = Pending(id: id, result: result, timeout: timeout)
                send(Outgoing(type: "capture", id: id, expires: Int64(Date().timeIntervalSince1970 * 1000) + 800), to: peer)
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                if self?.pending?.id == id { self?.resolve(nil) }
            }
        }
    }
}
