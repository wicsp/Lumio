import Foundation
@testable import LumioCapture
import LumioCaptureCore
import XCTest

final class HubUploadTests: XCTestCase {
    private let image = Data([0xff, 0xd8, 0xff, 0xd9])
    private let invalid = #"{"error":{"code":"INVALID","message":"Invalid screen capture request"}}"#
    private let accepted = #"{"id":"gln_example"}"#

    private func fixture() throws -> (GlanceRequest, BrowserPage) {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../Fixtures/glance-create.browser.json")
        let meta = try JSONDecoder().decode(GlanceRequest.self, from: Data(contentsOf: file))
        let page = try JSONDecoder().decode(BrowserPage.self, from: Data(
            #"{"url":"https://example.com/paper","format":"text","body":"Synthetic browser page"}"#.utf8))
        return (meta, page)
    }

    func testInvalidPageRetriesOnceWithTheSameScreenshot() async throws {
        let (meta, page) = try fixture()
        let stub = Stub([(400, invalid), (200, accepted)])
        let result = try await stub.hub.upload(meta, image: image, page: page)
        let requests = await stub.requests
        XCTAssertTrue(result.omittedPage)
        XCTAssertEqual(result.glance.id, "gln_example")
        XCTAssertEqual(requests.count, 2)
        guard requests.count == 2 else { return }
        for (index, request) in requests.enumerated() {
            XCTAssertEqual(request.url?.path, "/v2/glances")
            XCTAssertEqual(request.httpMethod, "POST")
            let body = try XCTUnwrap(request.httpBody)
            XCTAssertNotNil(body.range(of: image))
            let text = String(decoding: body, as: UTF8.self)
            XCTAssertTrue(text.contains(#"name="image""#))
            let payload = try XCTUnwrap(text.components(separatedBy: "\r\n\r\n").dropFirst().first)
            let metaJSON = try XCTUnwrap(payload.components(separatedBy: "\r\n").first)
            let sent = try JSONDecoder().decode(GlanceRequest.self, from: Data(metaJSON.utf8))
            XCTAssertEqual(sent.request_id, meta.request_id)
            XCTAssertEqual(sent.image?.width, meta.image?.width)
            XCTAssertEqual(sent.page != nil, index == 0)
        }
        XCTAssertTrue(String(decoding: try XCTUnwrap(requests[0].httpBody), as: UTF8.self).contains(page.body))
        XCTAssertFalse(String(decoding: try XCTUnwrap(requests[1].httpBody), as: UTF8.self).contains(#"name="page""#))
    }

    func testAcceptedPageNeedsNoRetry() async throws {
        let (meta, page) = try fixture()
        let stub = Stub([(200, accepted)])
        let result = try await stub.hub.upload(meta, image: image, page: page)
        let count = await stub.requests.count
        XCTAssertFalse(result.omittedPage)
        XCTAssertEqual(count, 1)
    }

    func testAuthenticationAndCapturesWithoutBothPartsDoNotRetry() async throws {
        let (meta, page) = try fixture()
        let unauthenticated = #"{"error":{"code":"UNAUTHENTICATED","message":"Invalid token"}}"#
        for (status, body, image, page) in [(401, unauthenticated, image, page),
                                           (400, invalid, image, nil), (400, invalid, nil, page)] {
            let stub = Stub([(status, body)])
            do {
                _ = try await stub.hub.upload(meta, image: image, page: page)
                XCTFail("Expected the request to fail")
            } catch {
                XCTAssertEqual(error.localizedDescription, status == 401 ? "Invalid token" : "Invalid screen capture request")
            }
            let count = await stub.requests.count
            XCTAssertEqual(count, 1)
        }
    }

    func testInvalidScreenshotStillFailsAfterRetry() async throws {
        let (meta, page) = try fixture()
        let stub = Stub([(400, invalid), (400, invalid)])
        do {
            _ = try await stub.hub.upload(meta, image: image, page: page)
            XCTFail("Expected the screenshot upload to fail")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Invalid screen capture request")
        }
        let count = await stub.requests.count
        XCTAssertEqual(count, 2)
    }
}

private actor Stub {
    private var responses: [(Int, String)]
    private(set) var requests: [URLRequest] = []

    init(_ responses: [(Int, String)]) { self.responses = responses }

    nonisolated var hub: Hub {
        Hub(origin: URL(string: "https://example.com")!, token: "synthetic") { request in
            try await self.send(request)
        }
    }

    private func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        let (status, body) = try XCTUnwrap(responses.first, "Unexpected request")
        responses.removeFirst()
        let response = try XCTUnwrap(HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: status,
                                                     httpVersion: nil, headerFields: nil))
        return (Data(body.utf8), response)
    }
}
