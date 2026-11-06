import { expect, test } from "bun:test";
import { KnowledgeCreateRequest, KnowledgeCreateResult } from "@lumio/schema";
import { renderKnowledgeNote, knowledgeTemplate, parseFrontmatter } from "../src/index.ts";
import fixtures from "../../../fixtures/knowledge-authoring/notes.json";
const ctx = { now: new Date("2026-11-06T00:00:00Z"), tz: "UTC", newId: (prefix: string) => `${prefix}_00000000000000000000000001` };
test("four kinds render valid metadata, intentional defaults and exact human body", () => {
  for (const fixture of fixtures) {
    const request = KnowledgeCreateRequest.parse(fixture), note = renderKnowledgeNote(request, ctx);
    KnowledgeCreateResult.parse(note.result);
    const parsed = parseFrontmatter(note.content);
    expect(parsed.body.toString()).toStartWith(request.body);
    expect(parsed.data.title).toBe(request.note.title);
    expect(parsed.data).not.toHaveProperty("request_id");
    expect(parsed.data).not.toHaveProperty("body");
    if (request.note.kind === "video") expect(parsed.data.kind).toBe("video");
    if (request.note.kind === "paper") expect(parsed.body.toString()).toContain("@article{Example_2026_Fixture,");
    if (request.note.kind !== "web") expect(parsed.data).not.toHaveProperty("status");
  }
});
test("body beginning with frontmatter syntax cannot set metadata; unsafe filenames fail", () => {
  const request = KnowledgeCreateRequest.parse(fixtures[0]);
  const body = "---\nid: attacker\n---\n# My text";
  const note = renderKnowledgeNote({ ...request, body }, ctx);
  expect(parseFrontmatter(note.content).body.toString()).toBe(body);
  expect(note.result.id).toBe("idea_00000000000000000000000001");
  for (const title of ["...", "???", "中".repeat(100)]) expect(() => renderKnowledgeNote({ ...request, note: { kind: "idea", title, tags: [] } }, ctx)).toThrow();
  expect(renderKnowledgeNote({ ...request, note: { kind: "idea", title: "../../safe", tags: [] } }, ctx).relativePath).toBe("research/ideas/safe.md");
});
test("versioned bilingual templates contain headings only, no AI content or links", () => {
  for (const kind of ["paper", "video", "web", "idea"] as const) for (const locale of ["en", "zh"] as const) {
    const result = knowledgeTemplate({ kind, locale }, key => key);
    expect(result.version).toBe("1"); expect(result.body).toStartWith("## ");
    expect(result.body).not.toContain("[["); expect(result.body).not.toContain("lumio:ai");
  }
});
