import { test, expect } from "bun:test";
import { footnotes, insertReference, referenceTrigger, writingContext } from "../src/client/note-text.ts";
import { NoteSave } from "../src/client/note-save.ts";
import type { KnowledgeDocument, KnowledgeUpdateRequest, KnowledgeUpdateResult } from "@lumio/schema";
test("context at a mid-paragraph completion retains the following sentence", () => {
    const text = "Earlier evidence [[X and the following sentence.";
    expect(referenceTrigger("[[later", 0)).toBeUndefined();
    expect(writingContext("", text, 20).focus).toBe("Earlier evidence  and the following sentence.");
});
const id = "idea_00000000000000000000000004";
function document(body = "before", revision = "a".repeat(64)): KnowledgeDocument { return { revision, document: { note: { id, type: "idea", title: "Title", path: "research/ideas/Note.md" }, body, frontmatter: {} } }; }
test("reference trigger preserves context and excludes fences, inline code and escaped brackets", () => {
    expect(referenceTrigger("Paragraph [[", 12)?.query).toBe("");
    expect(referenceTrigger("Paragraph [[X", 13)?.query).toBe("X");
    expect(writingContext("Title", "Paragraph [[X", 13).focus).toBe("Paragraph ");
    for (const text of ["```\n[[X", "`[[X`", "<!-- [[X", "\\[[X"])
        expect(referenceTrigger(text, text.length)).toBeUndefined();
});
test("footnote insertion is one edit, consumes existing closing brackets, reuses source and numbers by occurrence", () => {
    const key = "lumio-ref-00000000000000000000000001", text = "First [[X]] end", link = "[[Long|A long title]]";
    const edit = insertReference(text, { from: 6, to: 9 }, link, true, key);
    let next = text;
    for (const change of [...edit.changes].reverse())
        next = next.slice(0, change.from) + change.insert + next.slice(change.to ?? change.from);
    expect(next).toStartWith(`First [^${key}] end`);
    expect(footnotes(next).references[0]!.number).toBe(1);
    const again = insertReference(next + "\n[[", { from: next.length + 1, to: next.length + 3 }, link, true, "other");
    expect(again.changes).toHaveLength(1);
    expect(again.changes[0]!.insert).toBe(`[^${key}]`);
    expect(footnotes("B[^b] A[^a] B[^b]\n\n[^a]: [[A]]\n[^b]: [[B]]").references.map(r => r.number)).toEqual([1, 2, 1]);
});
test("manual footnotes, multiline definitions and missing/unused labels stay intact", () => {
    const text = "Text[^manual] `[^code]`\n\n[^manual]: first\n    second\n[^unused]: keep\n";
    const model = footnotes(text);
    expect(model.definitions[0]!.text).toBe("first\nsecond");
    expect(model.references).toHaveLength(1);
    expect(model.issues).toEqual(["unused"]);
});
test("save queue preserves typing during flight and chains expected revisions", async () => {
    const requests: KnowledgeUpdateRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    let current = document();
    const saver = new NoteSave(current, { async updateNote(_, request) { requests.push(request); if (requests.length === 1)
            await gate; current = document(request.body, (requests.length === 1 ? "b" : "c").repeat(64)); return { ...current, request_id: request.request_id }; }, async knowledgeDocument() { return current; } }, () => { });
    saver.change("Title", "first");
    const saved = saver.save();
    saver.change("Title", "second");
    release();
    expect(await saved).toBe(true);
    expect(requests.map(r => r.body)).toEqual(["first", "second"]);
    expect(requests[1]!.expected_revision).toBe("b".repeat(64));
    expect(saver.body).toBe("second");
    expect(saver.dirty).toBe(false);
});
test("uncertain save retries exact snapshot while newer draft remains queued", async () => {
    let persisted: KnowledgeUpdateResult | undefined;
    const ids: string[] = [];
    let first = true;
    const saver = new NoteSave(document(), { async updateNote(_, request) { ids.push(request.request_id); if (!persisted || persisted.request_id !== request.request_id)
            persisted = { ...document(request.body, "b".repeat(64)), request_id: request.request_id }; if (first) {
            first = false;
            throw new TypeError("response lost");
        } return persisted; }, async knowledgeDocument() { return persisted!; } }, () => { });
    saver.change("Title", "first");
    expect(await saver.save()).toBe(false);
    saver.change("Title", "second");
    expect(await saver.save()).toBe(true);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(saver.body).toBe("second");
});
test("external version after response stops continuation and retains draft", async () => {
    const saver = new NoteSave(document(), { async updateNote(_, request) { return { ...document(request.body, "b".repeat(64)), request_id: request.request_id }; }, async knowledgeDocument() { return document("external", "c".repeat(64)); } }, () => { });
    saver.change("Title", "mine");
    expect(await saver.save()).toBe(false);
    expect(saver.body).toBe("mine");
    expect((saver.error as {
        reason: string;
    }).reason).toBe("revision_conflict");
});
