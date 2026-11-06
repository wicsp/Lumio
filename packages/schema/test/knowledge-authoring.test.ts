import { expect, test } from "bun:test";
import { KnowledgeCreateRequest, KnowledgeCreateResult, KnowledgeTemplateRequest, PaperResolveRequest } from "../src/index.ts";
const request = { request_id: "test-note-request-01", note: { kind: "idea", title: "New" }, body: "My text" };
test("authoring accepts four kinds, optional source URL and strict writable fields", () => {
  for (const kind of ["idea", "video", "web", "paper"]) {
    const note = { kind, title: "  My note  ", ...(kind === "paper" ? { authors: ["A Writer"], year: 2024 } : {}) };
    const result = KnowledgeCreateRequest.parse({ ...request, note });
    expect(result.note.title).toBe("My note");
    for (const field of ["id", "type", "created", "updated", "path", "unknown"]) expect(KnowledgeCreateRequest.safeParse({ ...request, note: { ...note, [field]: "forged" } }).success).toBe(false);
  }
  expect(KnowledgeCreateRequest.safeParse({ ...request, body: "a".repeat(500001) }).success).toBe(false);
  expect(KnowledgeCreateRequest.safeParse({ ...request, note: { kind: "idea", title: "   " } }).success).toBe(false);
  for (const url of ["not a URL", "file:///etc/passwd", "javascript:alert(1)"]) expect(KnowledgeCreateRequest.safeParse({ ...request, note: { kind: "video", title: "Video", url } }).success).toBe(false);
  expect(KnowledgeCreateRequest.safeParse({ ...request, note: { kind: "paper", title: "Paper" } }).success).toBe(false);
  expect(KnowledgeCreateResult.safeParse({ id: "fake", path: "../oops", metadata: {} }).success).toBe(false);
});
test("template and import contracts reject unknown fields and invalid kinds", () => {
  expect(KnowledgeTemplateRequest.parse({ kind: "video" }).locale).toBe("en");
  expect(KnowledgeTemplateRequest.safeParse({ kind: "task" }).success).toBe(false);
  expect(PaperResolveRequest.safeParse({ input: "", url: "https://example.com" }).success).toBe(false);
});
