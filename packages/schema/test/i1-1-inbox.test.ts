import { test, expect } from "bun:test";
import {
  AIProfile, CAPABILITIES, CAPTURE_LIMITS, CONTRACTS, Capture, CaptureCommand, CaptureCreate, CaptureCreateResult, CaptureListArgs,
  Id, KnowledgeAIBinding, KnowledgeAIBindingUpdate, KnowledgeOriginal, KnowledgeOriginalShowArgs, ORIGINAL_CAPABILITY_NAME,
  ORIGINALS_DIRECTORY, OriginalFrontmatter, Paper, SearchHit, Source,
} from "../src/index.ts";

const ulid = "0".repeat(26);
const now = "2026-11-11T16:00:00+08:00";
const request_id = "capture-request-0001";
const sha = "a".repeat(64);
const capture = {
  id: `cap_${ulid}`, owner: `act_${ulid}`, channel: "web", url: "https://arxiv.org/abs/2401.00001", state: "ready", card: "ready",
  entity: { id: `pap_${ulid}`, type: "paper", title: "A Paper", path: "library/papers/He_2024_Paper.md", citekey: "He_2024_Paper" },
  ai_note: `ain_${ulid}`, original: `${ORIGINALS_DIRECTORY}/A Paper pap_${ulid}.md`, attempt: 1, revision: 1, created: now, updated: now,
};

test("capture ids use the cap prefix", () => {
  expect(Id.safeParse(`cap_${ulid}`).success).toBe(true);
});

test("create needs a URL or content; only http(s) URLs", () => {
  expect(CaptureCreate.safeParse({ request_id, channel: "web", url: "https://example.com/post" }).success).toBe(true);
  expect(CaptureCreate.safeParse({ request_id, channel: "extension", url: "https://example.com/p", title: "T", content: { format: "html", body: "<p>x</p>" } }).success).toBe(true);
  expect(CaptureCreate.safeParse({ request_id, channel: "web", content: { format: "text", body: "pasted" }, triage: "reference" }).success).toBe(true);
  expect(CaptureCreate.safeParse({ request_id, channel: "web" }).success).toBe(false);
  expect(CaptureCreate.safeParse({ request_id, channel: "web", url: "file:///etc/passwd" }).success).toBe(false);
  expect(CaptureCreate.safeParse({ request_id, channel: "web", url: "javascript:alert(1)" }).success).toBe(false);
  expect(CaptureCreate.safeParse({ request_id, channel: "web", url: `https://example.com/${"a".repeat(CAPTURE_LIMITS.max_url_chars)}` }).success).toBe(false);
  expect(CaptureCreate.safeParse({ request_id, channel: "web", url: "https://example.com", triage: "discard" }).success).toBe(false);
  expect(CaptureCreate.safeParse({ request_id, channel: "email", url: "https://example.com" }).success).toBe(false);
});

test("a capture records state, card and triage separately", () => {
  expect(Capture.safeParse(capture).success).toBe(true);
  expect(Capture.safeParse({ ...capture, state: "queued", card: "none", entity: undefined, ai_note: undefined, original: undefined }).success).toBe(true);
  expect(Capture.safeParse({ ...capture, state: "failed", error: { code: "blocked", message: "Private address" } }).success).toBe(true);
  expect(Capture.safeParse({ ...capture, triage: "discard", triaged: now }).success).toBe(true);
  expect(Capture.safeParse({ ...capture, state: "summarizing" }).success).toBe(false);
  expect(Capture.safeParse({ ...capture, error: { code: "oops", message: "x" } }).success).toBe(false);
  expect(Capture.safeParse({ ...capture, attempt: 0 }).success).toBe(false);
  expect(CaptureCreateResult.safeParse({ capture, duplicate: "discarded" }).success).toBe(true);
  expect(CaptureListArgs.parse({})).toEqual({ untriaged: true, limit: 50 });
});

test("commands are versioned and limited to the four actions", () => {
  const base = { request_id, expected_revision: 1 };
  for (const action of [
    { op: "triage", triage: "reference" }, { op: "triage", triage: "discard" }, { op: "retry" },
    { op: "retry", content: { format: "markdown", body: "# pasted" } }, { op: "reextract" }, { op: "summarize", depth: "deep" },
  ]) expect(CaptureCommand.safeParse({ ...base, action }).success).toBe(true);
  expect(CaptureCommand.safeParse({ request_id, action: { op: "reextract" } }).success).toBe(false);
  expect(CaptureCommand.safeParse({ ...base, action: { op: "summarize", depth: "chunks" } }).success).toBe(false);
  expect(CaptureCommand.safeParse({ ...base, action: { op: "link", target: "x" } }).success).toBe(false);
});

test("papers and sources accept the reference status", () => {
  const common = { title: "T", created: now, updated: now };
  expect(Source.parse({ ...common, type: "source", id: `src_${ulid}`, status: "reference" }).status).toBe("reference");
  expect(Source.parse({ ...common, type: "source", id: `src_${ulid}` }).status).toBe("to-read");
  expect(Paper.safeParse({ ...common, type: "paper", id: `pap_${ulid}`, citekey: "He_2020_LightGCN", authors: ["He"], year: 2020, status: "reference" }).success).toBe(true);
  expect(Source.safeParse({ ...common, type: "source", id: `src_${ulid}`, status: "archived" }).success).toBe(false);
});

test("original frontmatter belongs to a paper or source", () => {
  const fm = { of: `src_${ulid}`, url: "https://example.com/p", captured: now, extractor: "readability@1", lang: "zh-CN", sha256: sha };
  expect(OriginalFrontmatter.safeParse(fm).success).toBe(true);
  expect(OriginalFrontmatter.safeParse({ ...fm, of: `pap_${ulid}`, pdf: `art_${ulid}` }).success).toBe(true);
  expect(OriginalFrontmatter.safeParse({ ...fm, of: `idea_${ulid}` }).success).toBe(false);
  expect(OriginalFrontmatter.safeParse({ ...fm, extractor: "Readability" }).success).toBe(false);
  expect(OriginalFrontmatter.safeParse({ ...fm, title: "extra" }).success).toBe(false);
  expect(ORIGINALS_DIRECTORY.startsWith("files/")).toBe(true);
});

test("search hits may say where they matched", () => {
  const note = { type: "source", title: "T", path: "library/sources/T.md" };
  expect(SearchHit.safeParse({ note, snippet: "x" }).success).toBe(true);
  expect(SearchHit.safeParse({ note, snippet: "x", matched_in: "original", status: "to-read", created: now }).success).toBe(true);
  expect(SearchHit.safeParse({ note, snippet: "x", matched_in: "chunk" }).success).toBe(false);
});

test("knowledge AI bindings and the embedding engine", () => {
  expect(KnowledgeAIBinding.safeParse({ purpose: "knowledge.embedding", profile: `aip_${ulid}`, revision: 1 }).success).toBe(true);
  expect(KnowledgeAIBindingUpdate.safeParse({ request_id, purpose: "knowledge.summary", profile: null }).success).toBe(true);
  expect(KnowledgeAIBinding.safeParse({ purpose: "assistant", profile: `aip_${ulid}`, revision: 1 }).success).toBe(false);
  const profile = { id: `aip_${ulid}`, owner: `act_${ulid}`, name: "Embedding", connection: `aic_${ulid}`, engine: "embedding", model: "text-embedding-v4", revision: 1, created: now, updated: now };
  expect(AIProfile.safeParse(profile).success).toBe(true);
});

test("the Hub slice registers the existing original-reading contract as read-only", () => {
  expect(KnowledgeOriginalShowArgs.safeParse({ ref: "He_2020_LightGCN" }).success).toBe(true);
  expect(KnowledgeOriginal.safeParse({
    note: { id: `src_${ulid}`, type: "source", title: "T", path: "library/sources/T.md" }, path: `${ORIGINALS_DIRECTORY}/T src_${ulid}.md`,
    frontmatter: { of: `src_${ulid}`, captured: now, extractor: "pasted@1", sha256: sha }, body: "text",
  }).success).toBe(true);
  const capability = CAPABILITIES.find(c => c.name === ORIGINAL_CAPABILITY_NAME);
  expect(capability).toMatchObject({ kind: "read", args: KnowledgeOriginalShowArgs, result: KnowledgeOriginal });
});

test("inbox contracts are exported", () => {
  for (const name of ["capture-create", "capture-create-result", "capture", "capture-list", "capture-command", "original-frontmatter", "knowledge-ai-binding", "knowledge-ai-binding-update"]) {
    expect(name in CONTRACTS).toBe(true);
  }
});
