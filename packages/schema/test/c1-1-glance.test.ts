import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AssistantChatRequest, CAPABILITIES, CAPTURE_TOOLS, CONTRACTS, Capture, CaptureCreate, CaptureGlanceToolArgs, CaptureGlanceToolResult,
  GLANCE_CLIENT_DEFAULTS, GLANCE_LIMITS, GlanceAssistantReply, GlanceContextRetention, Glance, GlanceCreate, GlanceDeleteResult, Id, KnowledgeAIBindingUpdate, WORKBENCH_TOOLS,
} from "../src/index.ts";

const ulid = "0".repeat(26);
const now = "2026-11-15T20:00:00+08:00";
const request_id = "glance-request-0001";
const image = { format: "jpeg", width: 1600, height: 1000 } as const;
const app = { bundle_id: "com.google.Chrome", name: "Google Chrome" };
const block = (text: string, y: number) => ({ text, box: { x: 100, y, w: 800, h: 30 }, confidence: 0.98 });

const tap = {
  request_id, captured: now, app, window_title: "小红书", url: "https://www.xiaohongshu.com/explore/abc",
  image, pointer: { x: 400, y: 215 }, ocr: [block("第一段", 200), block("第二段", 240)], ocr_engine: "apple-vision@1",
};

test("glance ids use the gln prefix", () => {
  expect(Id.safeParse(`gln_${ulid}`).success).toBe(true);
});

test("a tap glance with screenshot, pointer and OCR", () => {
  const parsed = GlanceCreate.parse(tap);
  expect(parsed.trail).toEqual([]);
  expect(GlanceCreate.safeParse({ ...tap, trail: [{ x: 400, y: 215, t_ms: 0 }, { x: 420, y: 230, t_ms: 50 }] }).success).toBe(true);
});

test("a glance needs a screenshot, URL or selection", () => {
  expect(GlanceCreate.safeParse({ request_id, captured: now, app }).success).toBe(false);
  expect(GlanceCreate.safeParse({ request_id, captured: now, app, url: "http://127.0.0.1:7420/#work/task_x" }).success).toBe(true);
  expect(GlanceCreate.safeParse({ request_id, captured: now, app: { name: "Preview" }, selection_text: "选中的一句话" }).success).toBe(true);
  expect(GlanceCreate.safeParse({ request_id, captured: now, app, url: "file:///etc/passwd" }).success).toBe(false);
});

test("pointer, trail and OCR need a screenshot and must lie inside it", () => {
  const { image: _image, ...noImage } = tap;
  expect(GlanceCreate.safeParse(noImage).success).toBe(false);
  expect(GlanceCreate.safeParse({ ...noImage, ocr: [], ocr_engine: undefined, pointer: undefined }).success).toBe(true);
  expect(GlanceCreate.safeParse({ ...tap, pointer: { x: 1600, y: 10 } }).success).toBe(false);
  expect(GlanceCreate.safeParse({ ...tap, trail: [{ x: 10, y: 1000, t_ms: 0 }] }).success).toBe(false);
  expect(GlanceCreate.safeParse({ ...tap, ocr: [{ text: "x", box: { x: 1500, y: 0, w: 200, h: 10 } }] }).success).toBe(false);
  expect(GlanceCreate.safeParse({ ...tap, pointer: { x: -1, y: 0 } }).success).toBe(false);
});

test("trail time is non-decreasing and bounded", () => {
  expect(GlanceCreate.safeParse({ ...tap, trail: [{ x: 1, y: 1, t_ms: 50 }, { x: 2, y: 2, t_ms: 10 }] }).success).toBe(false);
  const many = Array.from({ length: GLANCE_LIMITS.max_trail_points + 1 }, (_, i) => ({ x: 1, y: 1, t_ms: i }));
  expect(GlanceCreate.safeParse({ ...tap, trail: many }).success).toBe(false);
});

test("OCR needs an engine and has a total text budget", () => {
  expect(GlanceCreate.safeParse({ ...tap, ocr_engine: undefined }).success).toBe(false);
  const big = Array.from({ length: 21 }, (_, i) => ({ text: "字".repeat(5000), box: { x: 0, y: i, w: 1, h: 1 } }));
  expect(GlanceCreate.safeParse({ ...tap, ocr: big }).success).toBe(false);
});

test("screenshot size is limited by edge length", () => {
  expect(GlanceCreate.safeParse({ ...tap, image: { ...image, width: GLANCE_LIMITS.max_image_edge + 1 } }).success).toBe(false);
  expect(GlanceCreate.safeParse({ ...tap, image: { ...image, format: "gif" } }).success).toBe(false);
});

test("glance record with pointing and usage", () => {
  const record = {
    id: `gln_${ulid}`, owner: `act_${ulid}`, captured: now, app, url: tap.url,
    image: { file: `art_${ulid}`, ...image, bytes: 300_000, sha256: "a".repeat(64) },
    pointer: tap.pointer, trail: [], ocr: tap.ocr, ocr_engine: "apple-vision@1",
    pointing: { method: "point", text: "第一段", blocks: [0] }, used_by: { capture: `cap_${ulid}` }, created: now,
  };
  expect(Glance.safeParse(record).success).toBe(true);
  expect(Glance.safeParse({ ...record, context_retention: { text: ["第一段"], image: false, source: true, status: "retained", finalized: now, enrichment_pending: true } }).success).toBe(true);
  expect(Glance.safeParse({ ...record, image: { ...record.image, purged: now }, used_by: { message: `amsg_${ulid}` } }).success).toBe(true);
  expect(Glance.safeParse({ ...record, image: undefined, ocr: [], pointer: undefined, pointing: { method: "none" }, lumio: { module: "work", id: `task_${ulid}` }, used_by: {} }).success).toBe(true);
  expect(Glance.safeParse({ ...record, pointing: { method: "guess" } }).success).toBe(false);
  expect(GlanceDeleteResult.safeParse({ id: `gln_${ulid}`, deleted: true }).success).toBe(true);
});

test("a capture can come from a glance, which then supplies URL and content", () => {
  expect(CaptureCreate.safeParse({ request_id, channel: "desktop", glance: `gln_${ulid}` }).success).toBe(true);
  expect(CaptureCreate.safeParse({ request_id, channel: "desktop", glance: `gln_${ulid}`, url: "https://example.com" }).success).toBe(false);
  expect(CaptureCreate.safeParse({ request_id, channel: "desktop", glance: `gln_${ulid}`, content: { format: "text", body: "x" } }).success).toBe(false);
  expect(CaptureCreate.safeParse({ request_id, channel: "desktop", glance: `cap_${ulid}` }).success).toBe(false);
  const capture = {
    id: `cap_${ulid}`, owner: `act_${ulid}`, channel: "desktop", glance: `gln_${ulid}`, state: "queued", card: "none",
    attempt: 1, revision: 1, created: now, updated: now,
  };
  expect(Capture.safeParse(capture).success).toBe(true);
});

test("chat accepts a glance but never together with focus", () => {
  const base = { request_id, conversation: `conv_${ulid}`, message: "这段什么意思" };
  expect(AssistantChatRequest.safeParse({ ...base, glance: `gln_${ulid}` }).success).toBe(true);
  expect(AssistantChatRequest.safeParse({ ...base, focus: {} }).success).toBe(true);
  expect(AssistantChatRequest.safeParse({ ...base, glance: `gln_${ulid}`, focus: {} }).success).toBe(false);
});

test("knowledge.vision is a knowledge AI purpose", () => {
  expect(KnowledgeAIBindingUpdate.safeParse({ request_id, purpose: "knowledge.vision", profile: `aip_${ulid}` }).success).toBe(true);
  expect(KnowledgeAIBindingUpdate.safeParse({ request_id, purpose: "knowledge.ocr", profile: null }).success).toBe(false);
});

test("capture.glance is a main-conversation tool, not a capability", () => {
  const names = new Set(CAPABILITIES.map((capability: { name: string }) => capability.name));
  for (const tool of CAPTURE_TOOLS) {
    expect(names.has(tool)).toBe(false);
    expect((WORKBENCH_TOOLS as readonly string[]).includes(tool)).toBe(false);
  }
  expect(CaptureGlanceToolArgs.safeParse({}).success).toBe(true);
  expect(CaptureGlanceToolArgs.safeParse({ reason: "和 wrapper 那篇有关" }).success).toBe(true);
  expect(CaptureGlanceToolArgs.safeParse({ glance: `gln_${ulid}` }).success).toBe(false); // 所见由 Hub 从当前消息取得
  expect(CaptureGlanceToolResult.safeParse({ capture: `cap_${ulid}`, title: "一段话" }).success).toBe(true);
});

test("client defaults are sane", () => {
  expect(GLANCE_CLIENT_DEFAULTS.tap_threshold_ms).toBeGreaterThan(0);
  expect(GLANCE_CLIENT_DEFAULTS.trail_sample_hz).toBeGreaterThan(0);
});

/**
 * 小助手（Swift）把它构造的请求写成样例文件 `apps/desktop/Tests/Fixtures/<契约名>.<说明>.json`，
 * 契约名是 CONTRACTS 的键（如 `glance-create.tap.json`）。这里逐个校验，保证 Swift 与契约一致（ADR 0066 第 7 节）。
 */
test("desktop client fixtures match the contract", () => {
  const dir = join(import.meta.dir, "../../../apps/desktop/Tests/Fixtures");
  if (!existsSync(dir)) return;
  const contracts = CONTRACTS as Record<string, { safeParse(value: unknown): { success: boolean; error?: unknown } }>;
  for (const file of readdirSync(dir).filter(name => name.endsWith(".json"))) {
    const name = file.slice(0, file.indexOf("."));
    const contract = contracts[name];
    expect(contract, `${file}: unknown contract ${name}`).toBeDefined();
    const result = contract!.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    expect(result.success, `${file}: ${String(result.error)}`).toBe(true);
  }
});

test("a browser page can accompany a screenshot and requires its own valid source URL", () => {
  const page = { format: "html", title: "Fixture" };
  expect(GlanceCreate.safeParse({ ...tap, page, url: "http://127.0.0.1:12345/test" }).success).toBe(true);
  expect(GlanceCreate.safeParse({ ...tap, page, url: undefined }).success).toBe(false);
  expect(GlanceCreate.safeParse({ ...tap, page, url: "https://user:password@example.com/" }).success).toBe(false);
  expect(GlanceCreate.safeParse({ ...tap, page: { format: "image" } }).success).toBe(false);
  expect(GlanceCreate.safeParse({ ...tap, page: { ...page, body: "multipart carries this" } }).success).toBe(false);
});

// ADR 0076: strict same-response retention envelope, compatible optional record field.
test("capture retention accepts bounded literal candidates and rejects ambiguous decisions", () => {
  const context = { text: ["相关原文"], image: false, source: true };
  expect(GlanceAssistantReply.parse({ reply: "[NOTE_ONLY]", context }).context).toEqual(context);
  expect(GlanceContextRetention.safeParse({ ...context, image: "false" }).success).toBe(false);
  expect(GlanceContextRetention.safeParse({ ...context, text: [" "] }).success).toBe(false);
  expect(GlanceContextRetention.safeParse({ ...context, text: ["x".repeat(2001)] }).success).toBe(false);
  expect(GlanceContextRetention.safeParse({ ...context, text: Array(9).fill("x") }).success).toBe(false);
  expect(GlanceAssistantReply.safeParse({ reply: "ok", context, extra: "OCR" }).success).toBe(false);
});
