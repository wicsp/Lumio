import { test, expect } from "bun:test";
import { cp, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { KnowledgeDocument, KnowledgeUpdateResult, KnowledgeRelatedResult, KnowledgeReferencesResult, ApiError } from "@lumio/schema";
import { webFileResponse, webResponse } from "../src/web.ts";
test("editing HTTP contracts, permissions, snippets, conflict and sensitive-content guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumio-edit-http-")), vault = join(root, "vault");
    await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
    const hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: join(root, "state") }), port: 0 }, { log() { } });
    try {
        hub.store.createActor("human", "human");
        const token = hub.store.createToken("human", "human"), id = "idea_00000000000000000000000004", path = `v2/knowledge/notes/${id}/document`;
        const call = (url: string, method = "GET", body?: unknown, credential = token) => fetch(new URL(url, hub.server.url), { method, headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const document = KnowledgeDocument.parse(await (await call(path)).json());
        const request = { request_id: "http-edit-0000000001", expected_revision: document.revision, title: "Changed", body: "Body with quantum widgets" };
        const saved = KnowledgeUpdateResult.parse(await (await call(path, "PUT", request)).json());
        expect(saved.document.body).toBe(request.body);
        expect(KnowledgeUpdateResult.parse(await (await call(path, "PUT", request)).json())).toEqual(saved);
        const stale = await call(path, "PUT", { ...request, request_id: "http-edit-0000000002" });
        expect(stale.status).toBe(409);
        expect(ApiError.parse(await stale.json()).error.reason).toBe("revision_conflict");
        const sensitive = await call(path, "PUT", { ...request, expected_revision: saved.revision, request_id: "http-edit-0000000003", body: "sk-" + "x".repeat(30) });
        expect(sensitive.status).toBe(400);
        const refs = KnowledgeReferencesResult.parse(await (await call("v2/knowledge/references", "POST", { source_kind: "idea", query: "quantum" })).json());
        expect(refs.hits.some(h => h.note.id === id && h.snippet.includes("quantum"))).toBe(true);
        const related = KnowledgeRelatedResult.parse(await (await call("v2/knowledge/related", "POST", { title: "", text: "", focus: "quantum" })).json());
        expect(related.hits.some(h => h.note.id === id)).toBe(true);
        for (const role of ["agent", "runtime"] as const) {
            hub.store.createActor(role, role);
            const credential = hub.store.createToken(role, role);
            for (const [url, method] of [[path, "GET"], [path, "PUT"], ["v2/knowledge/related", "POST"], ["v2/knowledge/references", "POST"]])
                expect((await call(url!, method, method === "GET" ? undefined : {}, credential)).status).toBe(403);
        }
    }
    finally {
        await hub.stop();
        await rm(root, { recursive: true, force: true });
    }
});
test("each HTML response gets a matching style-only nonce with no-store", async () => {
    const csp = "default-src 'none'; script-src 'self'; style-src 'self'", file = { type: "text/html", body: "<html><head></head><body></body></html>" };
    const first = webResponse(webFileResponse(file, "GET", csp), csp), second = webResponse(webFileResponse(file, "GET", csp), csp);
    const html = await first.text();
    const nonce = /content="([^"]+)"/.exec(html)![1]!;
    expect(first.headers.get("Content-Security-Policy")).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(first.headers.get("Content-Security-Policy")).not.toBe(second.headers.get("Content-Security-Policy"));
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
});
test("failed Git staging keeps a recoverable receipt and retry completes the same save", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumio-edit-git-")), vault = join(root, "vault");
    await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
    for (const args of [["init", "--quiet"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["config", "commit.gpgsign", "false"]]) {
        const proc = Bun.spawn(["git", ...args], { cwd: vault, stdout: "ignore", stderr: "pipe" });
        expect(await proc.exited).toBe(0);
    }
    const hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: join(root, "state") }), port: 0 }, { log() {} });
    try {
        hub.store.createActor("human", "human");
        const token = hub.store.createToken("human", "human"), path = "v2/knowledge/notes/idea_00000000000000000000000004/document";
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const doc = KnowledgeDocument.parse(await (await fetch(new URL(path, hub.server.url), { headers })).json());
        await writeFile(join(vault, ".git/index.lock"), "synthetic lock");
        const body = JSON.stringify({ request_id: "git-retry-0000000001", expected_revision: doc.revision, title: "Git retry", body: "Preserved draft" });
        const save = () => fetch(new URL(path, hub.server.url), { method: "PUT", headers, body });
        const first = await save();
        expect(first.status).toBe(500);
        expect(ApiError.parse(await first.json()).error.reason).toBe("save_uncertain");
        expect(hub.store.db.query<{ready:number},[]>("SELECT ready FROM knowledge_edits").get()!.ready).toBe(0);
        await rm(join(vault, ".git/index.lock"));
        const retried = await save();
        expect(retried.status).toBe(200);
        expect(KnowledgeUpdateResult.parse(await retried.json()).document.body).toBe("Preserved draft");
        expect(hub.store.db.query<{ready:number},[]>("SELECT ready FROM knowledge_edits").get()!.ready).toBe(1);
    } finally { await hub.stop(); await rm(root, { recursive: true, force: true }); }
});
