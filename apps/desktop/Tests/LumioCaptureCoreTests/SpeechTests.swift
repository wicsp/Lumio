import Foundation
import LumioCaptureCore
import XCTest

final class SpeechTests: XCTestCase {
    private let fixtureDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("Fixtures")

    func testSpeechFramesPreserveWholePCMSamples() {
        var audio = Data((0..<20_000).map { UInt8($0 % 251) })
        let original = audio
        var output = Data(), sizes: [Int] = []
        while !audio.isEmpty {
            let frame = SpeechPCM.removeFrame(from: &audio)
            sizes.append(frame.count)
            output.append(frame)
        }
        XCTAssertEqual(SpeechPCM.sampleRate, 16_000)
        XCTAssertEqual(sizes, [8192, 8192, 3616])
        XCTAssertEqual(output, original)
    }

    func testAssistantShowsTextAndRequestsConfirmation() throws {
        var stream = AssistantStream()
        XCTAssertTrue(try stream.read(#"{"type":"token","delta":"这是"}"#))
        XCTAssertTrue(try stream.read(#"{"type":"token","delta":"合成回复"}"#))
        XCTAssertEqual(stream.reply, "这是合成回复")
        XCTAssertFalse(try stream.read(#"{"type":"tool","tool":{"result":[1,2]}}"#))
        XCTAssertTrue(try stream.read(#"{"type":"notice","notice":{"source":"proposal"}}"#))
        XCTAssertTrue(stream.needsApproval)
        XCTAssertTrue(try stream.read(#"{"type":"result","messages":[{"role":"assistant","content":"定稿"},{"role":"user","content":"问题"}]}"#))
        XCTAssertTrue(stream.finished)
        XCTAssertEqual(stream.reply, "定稿")
        XCTAssertThrowsError(try stream.read(#"{"type":"error","error":"Synthetic failure"}"#))
    }

    func testWorkbenchActionWithAToolIDDoesNotInterruptTheAssistant() throws {
        let fixture = fixtureDirectory.appendingPathComponent("assistant-event.workbench.json")
        let action = try String(contentsOf: fixture, encoding: .utf8)
        var stream = AssistantStream()
        XCTAssertFalse(try stream.read(action))
        XCTAssertFalse(stream.finished)
        XCTAssertTrue(try stream.read(#"{"type":"tool","tool":{"result":{"status":"pending"}}}"#))
        XCTAssertTrue(stream.needsApproval)
        XCTAssertTrue(try stream.read(#"{"type":"result","messages":[{"role":"assistant","content":"Synthetic reply"}]}"#))
        XCTAssertTrue(stream.finished)
        XCTAssertEqual(stream.reply, "Synthetic reply")
    }

    func testStartFixture() throws {
        let start = SpeechStartFrame(token: "synthetic-paired-desktop", requestID: "20000000-0000-4000-8000-000000000002")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(start) + Data("\n".utf8)
        let fixture = fixtureDirectory.appendingPathComponent("speech-client-message.start.json")
        if ProcessInfo.processInfo.environment["LUMIO_UPDATE_DESKTOP_FIXTURES"] == "1" {
            try data.write(to: fixture, options: .atomic)
        } else {
            XCTAssertEqual(try Data(contentsOf: fixture), data)
        }
        let partial = try JSONDecoder().decode(SpeechReplyFrame.self, from: Data(#"{"type":"partial","seq":2,"text":"正在识别"}"#.utf8))
        XCTAssertEqual(partial.text, "正在识别")
    }
}
