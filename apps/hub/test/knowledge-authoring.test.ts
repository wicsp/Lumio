import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeCreateRequest, KnowledgeCreateResult, KnowledgeTemplateResult, ApiError, NoteDetail, SearchResult, PaperResolveResult, type KnowledgeTemplateRequest, type PaperResolveRequest } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { resolvePaper, type PaperFetch } from "../src/knowledge-authoring.ts";
import fixtures from "../../../fixtures/knowledge-authoring/notes.json";
let root: string, vault: string, hub: Awaited<ReturnType<typeof startHub>>, token: string;
const source = new URL("../../../fixtures/papers/", import.meta.url);
const fetchPaper: PaperFetch = async url => new Response(await readFile(new URL(url.includes("bibtex") ? "2002.02126.bib" : "2002.02126.xml", source), "utf8"));
const client = (auth = token) => {
  const call = async <T>(path: string, schema: { parse(value: unknown): T }, body?: unknown): Promise<T> => {
    const response = await fetch(`${hub.server.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); if (!response.ok) throw ApiError.parse(result).error; return schema.parse(result);
  };
  return {
    knowledgeTemplate: (input: KnowledgeTemplateRequest) => call(`v2/knowledge/templates?kind=${input.kind}&locale=${input.locale}`, KnowledgeTemplateResult),
    resolvePaper: (input: PaperResolveRequest) => call("v2/knowledge/papers/resolve", PaperResolveResult, input),
    createNote: (input: KnowledgeCreateRequest) => call("v2/knowledge/notes", KnowledgeCreateResult, input),
    show: (id: string) => call(`v1/notes/${id}`, NoteDetail),
    search: (q: string) => call(`v1/search?q=${encodeURIComponent(q)}`, SearchResult),
  };
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lumio-authoring-hub-")); vault = join(root, "vault");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: join(root, "state") }), port: 0 }, { log() {}, paperFetch: fetchPaper });
  hub.store.createActor("fixture-human", "human"); token = hub.store.createToken("fixture-human", "fixture-human");
});
afterEach(async () => { await hub.stop(); await rm(root, { recursive: true, force: true }); });
test("four types create through HTTP, immediately show/search with one audit each", async () => {
  for (const fixture of fixtures) {
    const request = KnowledgeCreateRequest.parse(fixture);
    const template = await client().knowledgeTemplate({ kind: request.note.kind, locale: "zh" }); KnowledgeTemplateResult.parse(template);
    const result = KnowledgeCreateResult.parse(await client().createNote(request));
    const detail = await client().show(result.id);
    expect(detail.body).toStartWith(request.body);
    expect((await client().search(request.note.title)).hits.some(hit => hit.note.id === result.id)).toBe(true);
    expect(await client().createNote(request)).toEqual(result);
  }
  expect(hub.store.db.query<{ n: number }, []>("SELECT count(*) n FROM audit WHERE operation='knowledge.create' AND execution_result LIKE 'created:%'").get()!.n).toBe(4);
});
test("concurrent double click and same-title saves never create duplicates", async () => {
  const request = KnowledgeCreateRequest.parse(fixtures[0]);
  const [first, second] = await Promise.all([client().createNote(request), client().createNote(request)]);
  expect(first).toEqual(second);
  const conflict = await client().createNote({ ...request, request_id: "another-fixture-request" }).catch(e => e);
  expect(conflict.code).toBe("CONFLICT");
  expect((await client().search(request.note.title)).hits).toHaveLength(1);
});
test("agent/runtime authorization precedes parsing and cannot read templates or resolve papers", async () => {
  for (const role of ["agent", "runtime"] as const) {
    hub.store.createActor(`fixture-${role}`, role); const credential = hub.store.createToken(`fixture-${role}`, `fixture-${role}`);
    for (const [path, method] of [["templates?kind=idea", "GET"], ["papers/resolve", "POST"], ["notes", "POST"]]) {
      const res = await fetch(`${hub.server.url}v2/knowledge/${path}`, { method, headers: { Authorization: `Bearer ${credential}` }, ...(method === "POST" ? { body: "not-json" } : {}) });
      expect(res.status).toBe(403); expect(ApiError.parse(await res.json()).error.reason).toBe("knowledge-authoring-human-only");
    }
  }
});
test("invalid fields and sensitive body are refused without creating a receipt", async () => {
  const request = KnowledgeCreateRequest.parse(fixtures[0]);
  const secret = "sk-" + "x".repeat(30);
  const result = await client().createNote({ ...request, body: secret }).catch(e => e);
  expect(result.code).toBe("INVALID"); expect(result.message).not.toContain(secret);
  const res = await fetch(`${hub.server.url}v2/knowledge/notes`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...request, note: { ...request.note, path: "../private.md" } }) });
  expect(res.status).toBe(400);
  expect(hub.store.db.query<{ n: number }, []>("SELECT count(*) n FROM knowledge_creations").get()!.n).toBe(0);
});
test("no configured vault clearly rejects creation and template loading", async () => {
  await hub.stop(); hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: join(root, "state") }), port: 0 }, { log() {} });
  const error = await client().knowledgeTemplate({ kind: "idea", locale: "en" }).catch(e => e);
  expect(error.code).toBe("INVALID"); expect(error.reason).toBe("knowledge-not-configured");
});
test("paper resolution uses fixture metadata and no arbitrary fetch input", async () => {
  const result = await client().resolvePaper({ input: "2002.02126" });
  expect(result.authors.length).toBeGreaterThan(0); expect(result.bibtex).toContain("@misc{He_2020_LightGCN");
  let calls = 0;
  await expect(resolvePaper({ input: "https://localhost/private" }, async () => { calls++; throw new Error(); })).rejects.toMatchObject({ code: "INVALID" }); expect(calls).toBe(0);
  await expect(resolvePaper({ input: "2002.02126" }, async () => { calls++; return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }); })).rejects.toMatchObject({ code: "INVALID" }); expect(calls).toBe(1);
  await expect(resolvePaper({ input: "2002.02126" }, async () => new Response("x".repeat(2_000_001)))).rejects.toMatchObject({ code: "INVALID" });
  await expect(resolvePaper({ input: "2002.02126" }, async () => new Promise(() => {}), 10)).rejects.toMatchObject({ code: "INVALID" });
});
test("versioned arXiv and Crossref resolve canonical identities; mismatches fail", async () => {
  expect((await resolvePaper({ input: "https://arxiv.org/abs/2002.02126v3" }, fetchPaper)).arxiv).toBe("2002.02126");
  const urls: string[] = [];
  const crossref = await resolvePaper({ input: "https://doi.org/10.1145/3397271.3401063" }, async url => {
    urls.push(url); return new Response(await readFile(new URL(url.includes("/transform/") ? "crossref-lightgcn.bib" : "crossref-lightgcn.json", source), "utf8"));
  });
  expect(crossref.doi).toBe("10.1145/3397271.3401063"); expect(crossref.firstAuthorFamily).toBe("He"); expect(crossref.bibtex).toContain("He_2020_LightGCN");
  expect(urls.every(url => new URL(url).hostname === "api.crossref.org")).toBe(true);
  await expect(resolvePaper({ input: "2002.02126" }, async () => new Response(await readFile(new URL("2403.14720.xml", source), "utf8")))).rejects.toMatchObject({ code: "INVALID" });
});
