import { expect, test } from "bun:test";
import { KnowledgeCreateRequest } from "@lumio/schema";
import { NoteDraft, importEmptyFields, noteRequest } from "../src/client/knowledge-draft.ts";
test("per-type drafts preserve exact body including intentionally empty values", () => {
  const state = new NoteDraft(); state.set("video", { title: "Video", body: "" }); state.set("idea", { body: "## Thought\n\nMy words" });
  expect(state.fields.get("video")).toEqual({ title: "Video", body: "" });
  expect(noteRequest("video", { title: "Video", body: "hello", url: "" }, "synthetic-request-01").note.kind).toBe("video");
  KnowledgeCreateRequest.parse(noteRequest("paper", { title: "Paper", authors: "Alice, Bob", year: "2026", body: "notes" }, "synthetic-request-02"));
});
test("uncertain saves freeze the exact request; definitive validation permits correction", () => {
  const state = new NoteDraft();
  const first = state.begin("idea", { title: "First", body: "saved text" }, "synthetic-request-01");
  state.failed({ code: "INTERNAL" });
  expect(state.begin("video", { title: "changed", body: "other" }, "synthetic-request-02")).toBe(first);
  state.failed({ code: "CONFLICT", reason: "note-recovery-conflict" }); expect(state.pending).toBe(first);
  state.failed({ code: "INVALID" }); expect(state.pending).toBeUndefined();
  expect(state.begin("idea", { title: "Fixed", body: "corrected" }, "synthetic-request-03").request_id).toBe("synthetic-request-03");
});
test("late imports fill empty fields and preserve manually typed text", () => {
  expect(importEmptyFields({ title: "My title", body: "My body", authors: "Me", year: "" }, { title: "Imported", authors: ["Someone"], year: 2026, bibtex: "bib" }))
    .toEqual({ title: "My title", body: "My body", authors: "Me", year: "2026", bibtex: "bib" });
});
test("actual API client conflict reasons unlock corrections while transport failures retain the request", async () => {
  const { createClient } = await import("@lumio/api-client");
  const state = new NoteDraft();
  const request = state.begin("idea", { title: "Conflict", body: "draft" }, "synthetic-request-04");
  const client = createClient({ url: "https://fixture.invalid", fetch: (async () => Response.json({ error: { code: "CONFLICT", message: "Already exists", reason: "file_exists" } }, { status: 409 })) as unknown as typeof fetch });
  state.failed(await client.createNote(request).catch(error => error));
  expect(state.pending).toBeUndefined();
  const imported = importEmptyFields({}, { title: "Paper", authors: ["Ada van Example"], year: 2026, firstAuthorFamily: "van Example" });
  expect(noteRequest("paper", imported, "synthetic-request-05").note).toMatchObject({ firstAuthorFamily: "van Example" });
  expect(importEmptyFields({ authors: "My Author" }, { title: "Paper", authors: ["Ada van Example"], year: 2026, firstAuthorFamily: "van Example" })).not.toHaveProperty("firstAuthorFamily");
});
