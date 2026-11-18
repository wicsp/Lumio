import CoreGraphics
import Foundation
import LumioCaptureCore
import XCTest

final class CaptureTests: XCTestCase {
    func testChromiumTabScriptSupportsEgoLite() throws {
        let bundleIDs = ["com.citrolabs.ego.lite", "com.google.Chrome", "com.microsoft.edgemac", "company.thebrowser.Browser"]
        for bundleID in bundleIDs {
            let script = try XCTUnwrap(chromiumTabScript(bundleID))
            XCTAssertEqual(script, """
                tell application id "\(bundleID)"
                    try
                        if mode of front window is "incognito" then return "__private__"
                    end try
                    return URL of active tab of front window
                end tell
                """)
        }
        XCTAssertNil(chromiumTabScript("example.reader"))
    }

    func testPressAndCoordinateConversions() {
        let frame = CGRect(x: -500, y: 200, width: 400, height: 300)
        let transform = PixelTransform(window: frame, width: 800, height: 600)
        XCTAssertEqual(transform.point(CGPoint(x: -300, y: 350)), PixelPoint(x: 400, y: 300))
        XCTAssertNil(transform.point(CGPoint(x: 0, y: 0)))
        XCTAssertEqual(transform.visionBox(CGRect(x: 0.25, y: 0.25, width: 0.5, height: 0.5)), PixelBox(x: 200, y: 150, w: 400, h: 300))
        var press = Press(started: 10)
        XCTAssertTrue(press.isTap(at: 10.249))
        XCTAssertFalse(press.isTap(at: 10.25))
        for index in 0...800 {
            press.add(CGPoint(x: -299, y: 350), at: 10 + Double(index) * CaptureLimits.sampleSeconds)
        }
        let trail = press.trail(in: transform)
        XCTAssertLessThanOrEqual(trail.count, CaptureLimits.maxTrailPoints)
        XCTAssertEqual(trail.first?.t_ms, 0)
        XCTAssertEqual(trail.last?.t_ms, 40_000)
        XCTAssertEqual(trail.map(\.t_ms), trail.map(\.t_ms).sorted())
    }

    func testOCRLimitAndOrder() {
        let lower = OCRBlock(text: "第二行", box: PixelBox(x: 2, y: 10, w: 2, h: 2))
        let upper = OCRBlock(text: String(repeating: "😀", count: 4000), box: PixelBox(x: 4, y: 2, w: 2, h: 2))
        let result = orderedOCR([lower, upper])
        XCTAssertEqual(result.map(\.box.y), [2, 10])
        XCTAssertEqual(result.first?.text.utf16.count, 5000)
        XCTAssertEqual(clippedUTF16("A😀B", limit: 2), "A")
    }

    func testContractFixtures() throws {
        let fixtureDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")
        let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV", request = "20000000-0000-4000-8000-000000000001"
        let glance = GlanceRequest(requestID: request, captured: Date(timeIntervalSince1970: 0),
                                   app: App(bundleID: "example.reader", name: "Synthetic Reader"), window: "Fixture",
                                   url: URL(string: "https://example.com/paper"), image: Image(format: "jpeg", width: 800, height: 600),
                                   pointer: PixelPoint(x: 40, y: 55), selection: "合成段落",
                                   ocr: [OCRBlock(text: "合成段落", box: PixelBox(x: 10, y: 20, w: 100, h: 60), confidence: 0.95)])
        let save = CaptureRequest(glance: "gln_\(id)", requestID: request)
        let chat = ChatRequest(conversation: "conv_\(id)", message: "Explain the highlighted text.", glance: "gln_\(id)", requestID: request)
        let pageContent = Data(#"{"url":"https://example.com/paper","format":"html","title":"Fixture page","body":"<main>Fixture browser text</main>"}"#.utf8)
        let page = try JSONDecoder().decode(BrowserPage.self, from: pageContent)
        XCTAssertTrue(page.isValid)
        var withPage = glance
        withPage.page = page.metadata
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        for (file, data) in [
            ("glance-create.tap.json", try encoder.encode(glance)),
            ("glance-create.browser.json", try encoder.encode(withPage)),
            ("capture-create.tap.json", try encoder.encode(save)),
            ("assistant-chat-request.hold.json", try encoder.encode(chat)),
        ] {
            let url = fixtureDirectory.appendingPathComponent(file)
            let finished = data + Data("\n".utf8)
            if ProcessInfo.processInfo.environment["LUMIO_UPDATE_DESKTOP_FIXTURES"] == "1" {
                try finished.write(to: url, options: .atomic)
            } else {
                XCTAssertEqual(try Data(contentsOf: url), finished, file)
            }
        }
        let part = try glance.multipart(boundary: "synthetic", screenshot: Data("JPEG".utf8))
        let text = String(decoding: part, as: UTF8.self)
        XCTAssertTrue(text.contains("name=\"meta\""))
        XCTAssertTrue(text.contains("name=\"image\"; filename=\"window.jpeg\""))
        XCTAssertTrue(text.hasSuffix("\r\nJPEG\r\n--synthetic--\r\n"))
        let combined = String(decoding: try withPage.multipart(boundary: "synthetic", screenshot: Data("JPEG".utf8), pageContent: page.body), as: UTF8.self)
        XCTAssertTrue(combined.contains("name=\"image\""))
        XCTAssertTrue(combined.contains("name=\"page\"; filename=\"page\""))
        XCTAssertTrue(combined.contains("<main>Fixture browser text</main>"))
    }
}
