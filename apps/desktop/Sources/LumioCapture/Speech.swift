import AVFoundation
import Foundation
import LumioCaptureCore

@MainActor final class SpeechCapture {
    private let socket: URLSessionWebSocketTask
    private let engine = AVAudioEngine()
    private let partial: (String) -> Void
    private var receiver: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var microphone: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var waiter: CheckedContinuation<String, Error>?
    private var resolution: Result<String, Error>?
    private var audio = Data()
    private var ready = false
    private var tapped = false
    private var released = false
    private var sentEnd = false
    private var cancelling = false
    private static let maxPending = 128_000
    private static let endTimeout = Duration.seconds(15)

    init(hub: Hub, partial: @escaping (String) -> Void) throws {
        self.partial = partial
        guard let token = hub.token, var url = URLComponents(url: hub.origin, resolvingAgainstBaseURL: false) else {
            throw CaptureFailure("请先配对 Hub")
        }
        url.scheme = hub.origin.scheme == "https" ? "wss" : "ws"
        url.path = "/v2/speech/transcribe"
        guard let url = url.url else { throw CaptureFailure("语音连接地址无效") }
        var request = URLRequest(url: url)
        request.setValue("zh", forHTTPHeaderField: "Accept-Language")
        socket = Hub.session.webSocketTask(with: request)
        socket.maximumMessageSize = 128_000
        socket.resume()
        receiver = Task { [weak self] in await self?.receive(token: token) }
        microphone = Task { [weak self] in await self?.startAudio() }
    }

    private func receive(token: String) async {
        do {
            try await writeJSON(SpeechStartFrame(token: token))
            while !Task.isCancelled {
                let message = try await socket.receive()
                guard case .string(let text) = message else { throw CaptureFailure("Hub 语音响应无效") }
                let frame = try JSONDecoder().decode(SpeechReplyFrame.self, from: Data(text.utf8))
                switch frame.type {
                case "ready":
                    ready = true
                    pump()
                case "partial":
                    partial(frame.text ?? "")
                case "final":
                    complete(.success(frame.text ?? ""))
                    return
                case "error":
                    throw CaptureFailure(frame.error?.message ?? "Hub 拒绝了语音输入")
                default: throw CaptureFailure("Hub 语音响应无效")
                }
            }
        } catch { complete(.failure(error)) }
    }

    private func startAudio() async {
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            complete(.failure(CaptureFailure("麦克风未授权")))
            return
        }
        guard !released, resolution == nil, !Task.isCancelled else { return }
        do {
            let input = engine.inputNode
            let source = input.outputFormat(forBus: 0)
            guard source.sampleRate > 0, source.channelCount > 0,
                  let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: SpeechPCM.sampleRate, channels: 1, interleaved: true),
                  let converter = AVAudioConverter(from: source, to: target) else { throw CaptureFailure("没有可用的麦克风") }
            input.installTap(onBus: 0, bufferSize: 2048, format: source) { [weak self] buffer, _ in
                let frames = AVAudioFrameCount(ceil(Double(buffer.frameLength) * target.sampleRate / source.sampleRate)) + 8
                guard let pcm = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: frames) else { return }
                var supplied = false
                var error: NSError?
                let status = converter.convert(to: pcm, error: &error) { _, inputStatus in
                    inputStatus.pointee = supplied ? .noDataNow : .haveData
                    if supplied { return nil }
                    supplied = true
                    return buffer
                }
                guard status != .error, pcm.frameLength > 0, let samples = pcm.int16ChannelData?.pointee else { return }
                let audio = Data(bytes: samples, count: Int(pcm.frameLength) * MemoryLayout<Int16>.size)
                DispatchQueue.main.async { self?.enqueue(audio) }
            }
            tapped = true
            try engine.start()
        } catch { complete(.failure(error)) }
    }

    private func enqueue(_ bytes: Data) {
        guard !released, !cancelling, resolution == nil else { return }
        guard audio.count + bytes.count <= Self.maxPending else {
            complete(.failure(CaptureFailure("语音连接网络过慢")))
            return
        }
        audio.append(bytes)
        pump()
    }

    private func pump() {
        guard ready, sender == nil, resolution == nil, !cancelling, !sentEnd else { return }
        sender = Task { [weak self] in
            guard let self else { return }
            defer { sender = nil }
            do {
                while audio.count >= 2 && resolution == nil && !cancelling {
                    let frame = SpeechPCM.removeFrame(from: &audio)
                    try await socket.send(.data(frame))
                }
                if released, resolution == nil, !cancelling {
                    sentEnd = true
                    try await writeJSON(SpeechControlFrame(type: "end"))
                }
            } catch { complete(.failure(error)) }
        }
    }

    func release() {
        guard !released else { return }
        released = true
        stopAudio()
        pump()
        deadline = Task { [weak self] in
            try? await Task.sleep(for: Self.endTimeout)
            if !Task.isCancelled { self?.complete(.failure(CaptureFailure("语音定稿超时"))) }
        }
    }

    func finalText() async throws -> String {
        if let resolution { return try resolution.get() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiter = $0 }
        } onCancel: {
            Task { @MainActor in self.cancel() }
        }
    }

    func cancel() {
        guard resolution == nil, !cancelling else { return }
        cancelling = true
        stopAudio()
        audio.removeAll()
        sender?.cancel()
        Task { [weak self] in
            guard let self else { return }
            try? await writeJSON(SpeechControlFrame(type: "cancel"))
            complete(.failure(CancellationError()))
        }
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            self?.complete(.failure(CancellationError()))
        }
    }

    private func stopAudio() {
        microphone?.cancel()
        if tapped {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            tapped = false
        }
    }

    private func complete(_ result: Result<String, Error>) {
        guard resolution == nil else { return }
        resolution = result
        stopAudio()
        audio.removeAll()
        receiver?.cancel()
        sender?.cancel()
        deadline?.cancel()
        socket.cancel(with: .normalClosure, reason: nil)
        waiter?.resume(with: result)
        waiter = nil
    }

    private func writeJSON<T: Encodable>(_ frame: T) async throws {
        let data = try JSONEncoder().encode(frame)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }
}
