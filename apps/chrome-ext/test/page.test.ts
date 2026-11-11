import { describe, expect, test } from "bun:test";
import { CAPTURE_LIMITS, CaptureCreate } from "@lumio/schema";
import { bilibiliText, buildCapture, json3Text, normalizeHub, strategyFor } from "../src/page.ts";

describe("which way to save a page", () => {
  test("papers and PDFs go to the Hub as links; videos use transcripts; other pages send their HTML", () => {
    expect(strategyFor("https://arxiv.org/abs/2401.00001")).toBe("link");
    expect(strategyFor("https://doi.org/10.1000/x")).toBe("link");
    expect(strategyFor("https://example.com/paper.pdf")).toBe("link");
    expect(strategyFor("https://www.youtube.com/watch?v=abc")).toBe("youtube");
    expect(strategyFor("https://youtu.be/abc")).toBe("youtube");
    expect(strategyFor("https://www.youtube.com/@channel")).toBe("page");
    expect(strategyFor("https://www.bilibili.com/video/BV1xx411c7mD?p=2")).toBe("bilibili");
    expect(strategyFor("https://example.com/post")).toBe("page");
    expect(strategyFor("chrome://extensions")).toBe("unsupported");
    expect(strategyFor("file:///tmp/a.html")).toBe("unsupported");
    expect(strategyFor(undefined)).toBe("unsupported");
  });
});

describe("transcripts", () => {
  test("YouTube json3 becomes one line per caption, without empty or repeated lines", () => {
    const raw = JSON.stringify({ events: [{ segs: [{ utf8: "Hello" }, { utf8: " world" }] }, { segs: [{ utf8: "\n" }] }, { segs: [{ utf8: "Hello world" }] }, { segs: [{ utf8: "Next" }] }, {}] });
    expect(json3Text(raw)).toBe("Hello world\nNext");
    expect(json3Text("not json")).toBe("");
  });
  test("Bilibili subtitles use body[].content", () => {
    expect(bilibiliText(JSON.stringify({ body: [{ content: "第一句" }, { content: " 第二句 " }] }))).toBe("第一句\n第二句");
  });
});

describe("capture requests", () => {
  const base = { url: "https://example.com/post", requestId: "ext-request-0001" };
  test("a page sends its HTML, or its text when the HTML is too large", () => {
    const page = { url: base.url, title: "Post", html: "<html><body><p>x</p></body></html>", text: "x" };
    const html = buildCapture({ ...base, strategy: "page", page });
    expect(html.note).toBe("page");
    expect(html.request.content?.format).toBe("html");
    expect(html.request.title).toBe("Post");
    const big = buildCapture({ ...base, strategy: "page", page: { ...page, html: "x".repeat(CAPTURE_LIMITS.max_content_chars + 1) } });
    expect(big.note).toBe("page-text");
    expect(big.request.content).toEqual({ format: "text", body: "x" });
    for (const built of [html, big]) expect(CaptureCreate.safeParse(built.request).success).toBe(true);
  });
  test("videos send the transcript, or say there was none", () => {
    const json3 = JSON.stringify({ events: [{ segs: [{ utf8: "Line one" }] }] });
    const video = buildCapture({ ...base, strategy: "youtube", transcript: { title: "Talk", description: "About", json3, auto: true } });
    expect(video.note).toBe("transcript");
    expect(video.request.content?.body).toContain("Line one");
    expect(video.request.content?.body).toContain("自动生成");
    const none = buildCapture({ ...base, strategy: "bilibili", transcript: { title: "Talk" } });
    expect(none.note).toBe("no-transcript");
    expect(none.request.content?.body).toContain("没有取到字幕");
    for (const built of [video, none]) expect(CaptureCreate.safeParse(built.request).success).toBe(true);
  });
  test("papers send only the link, with the extension channel and optional triage", () => {
    const paper = buildCapture({ ...base, url: "https://arxiv.org/abs/2401.00001", strategy: "link", title: "A paper", triage: "reference" });
    expect(paper.note).toBe("link");
    expect(paper.request).toEqual({ request_id: base.requestId, channel: "extension", url: "https://arxiv.org/abs/2401.00001", title: "A paper", triage: "reference" });
    expect(CaptureCreate.safeParse(paper.request).success).toBe(true);
  });
});

test("Hub addresses keep only the origin", () => {
  expect(normalizeHub("127.0.0.1:7420")).toBe("http://127.0.0.1:7420");
  expect(normalizeHub("https://mac.tailnet.ts.net/#inbox")).toBe("https://mac.tailnet.ts.net");
  expect(normalizeHub("ftp://x")).toBeUndefined();
  expect(normalizeHub("  ")).toBeUndefined();
});
