import { test, expect } from "bun:test";
import { createClient } from "../src/index.ts";
const id = "idea_00000000000000000000000004";
const doc = { document: { note: { id, type: "idea" as const, title: "Fixture", path: "research/ideas/Main.md" }, frontmatter: {}, body: "text" }, revision: "a".repeat(64) };
test("editing client uses strict contracts and preserves conflict decision fields", async () => {
    const calls: Array<{
        path: string;
        method: string;
        body: unknown;
    }> = [];
    const client = createClient({ url: "http://localhost", token: "fixture", fetch: (async (url: URL, init: RequestInit) => { const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path: url.pathname, method: init.method!, body }); return Response.json(url.pathname.endsWith("/related") ? { method: "lexical", hits: [] } : url.pathname.endsWith("/references") ? { hits: [] } : init.method === "PUT" ? { ...doc, request_id: body.request_id } : doc); }) as unknown as typeof fetch });
    expect(await client.knowledgeDocument(id)).toEqual(doc);
    await client.updateNote(id, { request_id: "client-edit-0000001", expected_revision: doc.revision, title: "Fixture", body: "text" });
    await client.relatedNotes({ title: "", focus: "paragraph", text: "", exclude_id: id });
    await client.noteReferences({ source_id: id, query: "X" });
    expect(calls.map(c => c.method)).toEqual(["GET", "PUT", "POST", "POST"]);
    expect(calls[1]!.path).toBe(`/v2/knowledge/notes/${id}/document`);
    expect(calls[3]!.body).toEqual({ source_id: id, query: "X" });
    expect(() => client.updateNote(id, { request_id: "bad", expected_revision: "stale", title: "", body: "" })).toThrow();
    expect(calls.length).toBe(4);
    const broken = createClient({ url: "http://localhost", token: "fixture", fetch: (async () => Response.json({ ...doc, extra: true })) as unknown as typeof fetch });
    await expect(broken.knowledgeDocument(id)).rejects.toMatchObject({ code: "INTERNAL" });
    const conflict = createClient({ url: "http://localhost", token: "fixture", fetch: (async () => Response.json({ error: { code: "CONFLICT", message: "Changed", reason: "revision_conflict" } }, { status: 409 })) as unknown as typeof fetch });
    await expect(conflict.knowledgeDocument(id)).rejects.toMatchObject({ code: "CONFLICT", reason: "revision_conflict" });
});
