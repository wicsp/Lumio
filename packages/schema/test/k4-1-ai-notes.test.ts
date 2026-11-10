import { expect, test } from "bun:test";
import {
  AI_NOTE_CAPABILITY_NAMES, AiNote, CAPABILITY_NAMES, CONTRACTS, CapabilityName, DerivedFrom, Entity, ID_PREFIXES,
  KnowledgeAiNoteCreateArgs, KnowledgeAiNoteResult, KnowledgeAiNoteUpdateArgs, LumioLink, MODULE_ID_PREFIXES,
  NOTE_TYPES, Post, ResourceRef, idOfLumioLink, lumioLink,
} from "../src/index.ts";

// ADR 0051（K4-1）：AI 笔记、derived_from 与 lumio: 链接的契约。只用合成数据。
const ULID = "01JA0000000000000000000000";
const ain = `ain_${ULID}`;
const amsg = `amsg_${ULID}`;
const base = { id: ain, type: "ai-note", title: "Synthetic summary", created: "2026-11-10T08:00:00+08:00", updated: "2026-11-10T08:00:00+08:00" };
const revision = "a".repeat(64);

test("ai-note is a knowledge entity with the ain prefix", () => {
  expect(ID_PREFIXES["ai-note"]).toBe("ain");
  expect(NOTE_TYPES).toContain("ai-note");
  expect(MODULE_ID_PREFIXES.knowledge).toContain("ain");
  expect(CONTRACTS["ai-note"]).toBe(AiNote);
  const note = Entity.parse({ ...base, generated_by: `act_${ULID}`, model: "synthetic-model", derived_from: [amsg, "https://example.com/a"] });
  expect(note.type).toBe("ai-note");
  expect(ResourceRef.safeParse({ module: "knowledge", id: ain }).success).toBe(true);
  expect(ResourceRef.safeParse({ module: "assistant", id: ain }).success).toBe(false);
});

test("ai-note tolerates hand-placed files and rejects wrong prefixes", () => {
  expect(AiNote.parse({ ...base, generated_by: null, model: null }).generated_by).toBeUndefined();
  expect(AiNote.safeParse({ ...base, id: `idea_${ULID}` }).success).toBe(false);
  expect(AiNote.safeParse({ ...base, generated_by: `amsg_${ULID}` }).success).toBe(false);
  // 未知字段原样保留（vault 实体是宽松对象）
  expect(AiNote.parse({ ...base, editor_field: 1 })).toHaveProperty("editor_field", 1);
});

test("derived_from is a common optional field of Lumio IDs or http(s) URLs", () => {
  expect(DerivedFrom.safeParse(amsg).success).toBe(true);
  expect(DerivedFrom.safeParse(`job_${ULID}`).success).toBe(true);
  expect(DerivedFrom.safeParse("https://example.com/x").success).toBe(true);
  for (const bad of ["file:///etc/passwd", "lumio:" + amsg, "not-an-id", `zzz_${ULID}`]) expect(DerivedFrom.safeParse(bad).success).toBe(false);
  const idea = Entity.parse({ id: `idea_${ULID}`, type: "idea", title: "Synthetic", created: base.created, updated: base.updated, derived_from: [amsg] });
  expect(idea.derived_from).toEqual([amsg]);
  // 留空视为未填（ADR 0008）
  expect(Entity.parse({ id: `idea_${ULID}`, type: "idea", title: "S", created: base.created, updated: base.updated, derived_from: null }).derived_from).toBeUndefined();
});

test("post keeps its default and accepts the widened sources", () => {
  const post = { id: `post_${ULID}`, type: "post", title: "S", created: base.created, updated: base.updated, format: "text" };
  expect(Post.parse(post).derived_from).toEqual([]);
  expect(Post.parse({ ...post, derived_from: [`src_${ULID}`, amsg, "https://example.com"] }).derived_from).toHaveLength(3);
});

test("lumio: links carry only an ID", () => {
  expect(lumioLink(amsg)).toBe(`lumio:${amsg}`);
  expect(idOfLumioLink(`lumio:${amsg}`)).toBe(amsg);
  for (const bad of ["lumio:", "lumio:amsg_x", `lumio://${amsg}`, `https://hub/${amsg}`, `lumio:${amsg}#x`]) {
    expect(LumioLink.safeParse(bad).success).toBe(false);
    expect(idOfLumioLink(bad)).toBeUndefined();
  }
});

test("AI note capability arguments and results", () => {
  expect(KnowledgeAiNoteCreateArgs.parse({ title: " Summary ", body: "text", derived_from: [`src_${ULID}`] }).title).toBe("Summary");
  for (const bad of [{ title: "", body: "" }, { title: "t", body: "b", id: ain }, { title: "t", body: "b", derived_from: ["ftp://x"] }, { title: "t", body: "b", generated_by: `act_${ULID}` }]) {
    expect(KnowledgeAiNoteCreateArgs.safeParse(bad).success).toBe(false);
  }
  expect(KnowledgeAiNoteUpdateArgs.parse({ note: ain, expected_revision: revision, body: "new" }).body).toBe("new");
  expect(KnowledgeAiNoteUpdateArgs.safeParse({ note: ain, expected_revision: revision }).success).toBe(false);
  expect(KnowledgeAiNoteUpdateArgs.safeParse({ note: `idea_${ULID}`, expected_revision: revision, body: "x" }).success).toBe(false);
  expect(KnowledgeAiNoteUpdateArgs.safeParse({ note: ain, body: "x" }).success).toBe(false);
  expect(KnowledgeAiNoteResult.parse({ note: { id: ain, type: "ai-note", title: "S", path: "ai/notes/S.md" }, revision }).revision).toBe(revision);
});

test("AI note capabilities have valid names and are registered in the catalog", () => {
  for (const name of AI_NOTE_CAPABILITY_NAMES) {
    expect(CapabilityName.safeParse(name).success).toBe(true);
    expect((CAPABILITY_NAMES as readonly string[]).includes(name)).toBe(true);
  }
});
