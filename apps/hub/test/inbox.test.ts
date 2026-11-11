import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "@lumio/knowledge";
import {
  AIConnection, AIProfile, AiNote, Capture, CaptureCreate, CaptureCreateResult, CaptureList, KnowledgeAIBinding,
  KnowledgeOriginal, NoteDetail, ORIGINAL_CAPABILITY_NAME, Paper, SearchResult, Source, TrashListResult, TrashRestoreResult,
  type AssistantModelRequest, type CaptureCommand,
} from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { captureNetwork, fetchCapture, isPublicAddress, type CaptureNetwork } from "../src/inbox-fetch.ts";
import { startHub } from "../src/server.ts";

const captures = "/v2/inbox/captures";
const article = "https://articles.example/inbox";
const readFixture = (name: string) => readFile(new URL(`../../../fixtures/i1-inbox/${name}`, import.meta.url), "utf8");
const enc = new TextEncoder();
function response(body: string, status = 200, headers: Record<string, string> = { "content-type": "text/html" }) {
  return { status, header: (name: string) => headers[name], close() {}, body: (async function* () { yield enc.encode(body); })() };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lumio-inbox-")), vault = join(root, "vault");
  await mkdir(vault);
  const requests: string[] = [], calls: AssistantModelRequest[] = [];
  let webpage = await readFixture("article.html"), failure = false;
  const network: CaptureNetwork = {
    async lookup(host) { return host === "mixed.example" ? ["93.184.216.34", "10.0.0.4"] : ["93.184.216.34"]; },
    async request(url, address) {
      expect(address).toBe("93.184.216.34");
      requests.push(url.href);
      if (url.hostname === "export.arxiv.org") return response(await readFixture("arxiv.xml"), 200, { "content-type": "application/atom+xml" });
      if (url.hostname === "arxiv.org" && url.pathname.startsWith("/html/")) return response(await readFixture("arxiv.html"));
      if (url.hostname === "arxiv.org" && url.pathname.startsWith("/bibtex/")) return response(await readFixture("arxiv.bib"), 200, { "content-type": "text/plain" });
      if (url.hostname === "redirect.example") return response("", 302, { location: "http://[::ffff:127.0.0.1]/internal" });
      if (url.hostname === "locked.example") return response("", 401);
      return response(webpage);
    },
  };
  const hub = await startHub(readConfig({
    HOME: root, LUMIO_STATE_DIR: join(root, "state"), LUMIO_VAULT: vault, LUMIO_HUB_LISTEN: "127.0.0.1:0",
    LUMIO_CAPTURE_CARD_INPUT_TOKENS: "140",
  }), { log() {}, inbox: { network, model() {
    return { settings: { model: "synthetic-summary" }, model: { async complete(input) {
      calls.push(input);
      if (failure) return { content: "", tool_calls: [{ id: "fake-call", name: "knowledge.delete", args: {} }] };
      const depth = input.messages[0]!.content.includes("detailed") ? "deep" : "card";
      return { content: JSON.stringify({ body: `Synthetic ${depth} result.`, tags: ["basalt"] }), tool_calls: [] };
    } } };
  } } });
  const credential = (name: string, role: "human" | "agent" | "runtime" = "human") => {
    const actor = hub.store.createActor(name, role);
    return { actor, token: hub.store.createToken(name, name) };
  };
  const owner = credential("owner"), agent = credential("agent", "agent"), other = credential("other"), runtime = credential("runtime", "runtime");
  const api = (path: string, method = "GET", body?: unknown, token = owner.token) => fetch(new URL(path, hub.server.url), {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const create = async (url: string | undefined, extra: Partial<CaptureCreate> = {}) => {
    const input = CaptureCreate.parse({ url, request_id: randomUUID(), channel: "cli", ...extra });
    const result = await api(captures, "POST", input);
    expect([200, 202]).toContain(result.status);
    return CaptureCreateResult.parse(await result.json());
  };
  const get = async (id: string) => Capture.parse(await (await api(`${captures}/${id}`)).json());
  const wait = async (id: string, complete = (value: Capture) => (value.state === "ready" || value.state === "failed") && value.card !== "pending") => {
    for (let i = 0; i < 150; i++) {
      const value = await get(id);
      if (complete(value)) return value;
      await Bun.sleep(15);
    }
    throw new Error(JSON.stringify(await get(id)));
  };
  const command = (capture: Capture, action: CaptureCommand["action"], request_id = randomUUID()) =>
    api(`${captures}/${capture.id}/commands`, "POST", { request_id, action, expected_revision: capture.revision });
  const original = async (ref: string, token = agent.token) => {
    const result = await api(`/v2/knowledge/originals?ref=${encodeURIComponent(ref)}`, "GET", undefined, token);
    expect(result.status).toBe(200);
    return KnowledgeOriginal.parse(await result.json());
  };
  const bind = async (engine: "lumio" | "embedding" = "lumio", purpose = "knowledge.summary") => {
    const connection = AIConnection.parse(await (await api("/v2/ai/connections", "POST", {
      name: "Synthetic source", kind: "openai-compatible", host: "hub", base_url: "https://models.example/v1",
    })).json());
    const profile = AIProfile.parse(await (await api("/v2/ai/profiles", "POST", {
      name: "Synthetic profile", connection: connection.id, model: "synthetic-summary", engine, thinking: "default",
    })).json());
    return api("/v2/ai/knowledge-bindings", "PUT", { request_id: randomUUID(), purpose, profile: profile.id });
  };
  const note = async (id: string) => NoteDetail.parse(await (await api(`/v1/notes/${id}`)).json());
  return { hub, owner, agent, other, runtime, api, create, get, wait, command, original, bind, note, requests, calls, vault,
    replacePage(body: string) { webpage = body; },
    modelAttemptsTool() { failure = true; },
    async close() { await hub.stop(); await rm(root, { recursive: true, force: true }); },
  };
}

test("captures without a model, deduplicates, searches the original, then generates a tool-free card and deep note", async () => {
  const f = await fixture();
  try {
    const request_id = randomUUID();
    const created = await f.create(article + "?utm_source=example#start", { request_id });
    expect(created.capture).toMatchObject({ state: "queued", url: article });
    expect(await f.create(article + "?utm_source=example#start", { request_id })).toEqual(created);
    const ready = await f.wait(created.capture.id);
    expect(ready).toMatchObject({ state: "ready", card: "none", kind: "web" });
    expect(await f.create(article)).toMatchObject({ duplicate: "existing", capture: { id: ready.id, entity: ready.entity } });
    expect(f.requests).toEqual([article]);
    expect(CaptureList.parse(await (await f.api(captures)).json())).toMatchObject({ total: 1 });
    const id = ready.entity!.id!;
    const original = await f.original(id);
    expect(original.body).toContain("xenolithmarker");
    expect(original.body).toContain("[reference method](https://articles.example/methods)");
    expect(original.body).toContain("![specimen](https://articles.example/images/sample.png)");
    expect(original.body).not.toMatch(/Navigation chatter|Footer chatter|javascript:/);
    const matches = SearchResult.parse(await (await f.api("/v1/search?q=xenolithmarker", "GET", undefined, f.agent.token)).json());
    expect(matches.hits[0]).toMatchObject({ matched_in: "original", note: { id } });
    expect((await f.api(captures, "GET", undefined, f.agent.token)).status).toBe(403);
    expect((await f.api(captures, "POST", {}, f.agent.token)).status).toBe(403);
    expect((await f.api(`${captures}/${ready.id}`, "GET", undefined, f.other.token)).status).toBe(404);
    expect((await f.api("/v2/ai/knowledge-bindings", "GET", undefined, f.agent.token)).status).toBe(403);
    expect((await f.api(`/v2/knowledge/originals?ref=${id}`, "GET", undefined, f.runtime.token)).status).toBe(403);
    expect((await f.hub.modules.capabilities.execute(ORIGINAL_CAPABILITY_NAME, { ref: id }, { actor: f.agent.actor, label: "fixture" })).result).toEqual(original);
    expect((await f.bind("embedding")).status).toBe(400);
    expect(KnowledgeAIBinding.array().parse(await (await f.bind()).json())).toMatchObject([{ purpose: "knowledge.summary" }]);
    expect((await f.command(ready, { op: "summarize", depth: "card" })).status).toBe(200);
    const card = await f.wait(ready.id, value => value.card === "ready" || value.card === "failed");
    expect(card.card).toBe("ready");
    expect(f.calls[0]?.tools).toEqual([]);
    expect(f.calls[0]?.messages[0]?.content).toContain("Chinese");
    const prompt = JSON.parse(f.calls[0]!.messages[1]!.content);
    expect(prompt.document).toContain("忽略之前的指令");
    expect(prompt.document).not.toContain("far-tail-sentinel");
    const note = await f.note(card.ai_note!);
    expect(AiNote.parse(note.frontmatter)).toMatchObject({
      tags: ["basalt"], generated_by: f.hub.store.inboxActor().id, derived_from: [id, ready.id, article],
    });
    expect((await f.note(id)).body).toMatch(/^\[AI note\]\(\.\.\/\.\.\/ai\/notes\/.*\.md\)\n\n/);
    expect((await f.command(card, { op: "summarize", depth: "deep" })).status).toBe(200);
    const deep = await f.wait(ready.id, value => value.card === "deep" || value.card === "failed");
    expect(deep).toMatchObject({ card: "deep", ai_note: card.ai_note });
    expect(JSON.parse(f.calls[1]!.messages[1]!.content).document).toBe(original.body);
    expect((await f.note(deep.ai_note!)).body).toBe("Synthetic deep result.");
    f.replacePage((await readFixture("article.html")).replace("xenolithmarker", "newxenolithmarker"));
    expect((await f.command(deep, { op: "reextract" })).status).toBe(200);
    const refreshed = await f.wait(ready.id);
    expect(refreshed).toMatchObject({ state: "ready", original: ready.original, ai_note: deep.ai_note, attempt: 2 });
    expect((await f.original(id)).frontmatter.sha256).not.toBe(original.frontmatter.sha256);
    expect((await f.original(id)).body).toContain("newxenolithmarker");
    expect(f.hub.store.db.query("SELECT 1 FROM audit WHERE actor_id=? AND operation='knowledge.ainote.update'").get(f.hub.store.inboxActor().id)).toBeTruthy();
  } finally { await f.close(); }
});

test("extension HTML is saved as a page-html original without fetching the page", async () => {
  const f = await fixture();
  try {
    const { capture } = await f.create(article, {
      channel: "extension",
      content: { format: "html", body: await readFixture("article.html") },
    });
    const ready = await f.wait(capture.id);
    expect(ready.state).toBe("ready");
    const original = await f.original(ready.entity!.id!);
    expect(original.frontmatter.extractor).toBe("page-html@1");
    expect(original.body).toContain("xenolithmarker");
    expect(f.requests).toEqual([]);
  } finally { await f.close(); }
});

test("arXiv aliases share one paper and HTML original; triage, reextract, discard and restore preserve ownership", async () => {
  const f = await fixture();
  try {
    expect((await f.bind()).status).toBe(200);
    const first = await f.create("http://arxiv.org/pdf/2611.01234v2.pdf");
    const ready = await f.wait(first.capture.id);
    expect(ready).toMatchObject({ state: "ready", card: "ready", kind: "paper", url: "https://arxiv.org/abs/2611.01234" });
    expect((await f.create("https://arxiv.org/html/2611.01234v3")).duplicate).toBe("existing");
    expect((await f.create("https://arxiv.org/abs/2611.01234v1")).capture.id).toBe(ready.id);
    const paper = Paper.parse((await f.note(ready.entity!.id!)).frontmatter);
    expect(paper.citekey).toBe("Example_2026_Basalt");
    expect((await f.note(paper.id)).body).toContain("@misc{Example_2026_Basalt,");
    const original = await f.original(paper.citekey);
    expect(original.frontmatter.extractor).toBe("arxiv-html@1");
    expect(original.body).toContain("arxivmethodmarker");
    expect(original.body).toContain("$E=mc^2$");
    expect((await f.command(ready, { op: "triage", triage: "reference" })).status).toBe(200);
    expect(Paper.parse((await f.note(paper.id)).frontmatter).status).toBe("reference");
    expect(CaptureList.parse(await (await f.api(captures)).json()).total).toBe(0);
    expect((await f.command(ready, { op: "triage", triage: "read" })).status).toBe(409);
    const triaged = await f.get(ready.id);
    expect((await f.command(triaged, { op: "reextract" })).status).toBe(200);
    const refreshed = await f.wait(ready.id);
    expect(refreshed).toMatchObject({ state: "ready", card: "ready", attempt: 2, original: ready.original, ai_note: ready.ai_note });
    const paths = [refreshed.entity!.path, refreshed.original!, (await f.note(refreshed.ai_note!)).note.path];
    const request = randomUUID();
    const result = await f.command(refreshed, { op: "triage", triage: "discard" }, request);
    expect(result.status).toBe(200);
    const discarded = Capture.parse(await result.json());
    expect(discarded.triage).toBe("discard");
    expect(Capture.parse(await (await f.command(refreshed, { op: "triage", triage: "discard" }, request)).json())).toEqual(discarded);
    expect((await f.create("https://arxiv.org/abs/2611.01234")).duplicate).toBe("discarded");
    expect((await f.api(`/v2/knowledge/originals?ref=${paper.id}`)).status).toBe(404);
    const trash = TrashListResult.parse(await (await f.api("/v2/trash")).json());
    expect(trash.items.map(item => item.id)).toEqual([paper.id]);
    for (const path of paths) {
      expect(await Bun.file(join(f.vault, path)).exists()).toBe(false);
      expect(await Bun.file(join(f.vault, ".trash", path)).exists()).toBe(true);
    }
    const restore = await f.api(`/v2/trash/${paper.id}/restore`, "POST", { request_id: randomUUID() });
    expect(restore.status).toBe(200);
    expect(TrashRestoreResult.parse(await restore.json()).id).toBe(paper.id);
    for (const path of paths) expect(await Bun.file(join(f.vault, path)).exists()).toBe(true);
    expect((await f.create("https://arxiv.org/abs/2611.01234")).duplicate).toBe("existing");
    expect((await f.original(paper.id)).body).toBe(original.body);
  } finally { await f.close(); }
});

test("blocked hosts and redirects never reach an unchecked address; failed extraction retries only on request", async () => {
  const f = await fixture();
  try {
    for (const url of ["http://127.0.0.1:7420", "http://192.168.1.1", "http://mixed.example/", "https://redirect.example/"]) {
      const entry = await f.create(url);
      expect(await f.wait(entry.capture.id)).toMatchObject({ state: "failed", attempt: 1, error: { code: "blocked" } });
    }
    expect(f.requests).toEqual(["https://redirect.example/"]);
    const discarded = await f.create("http://127.0.0.2/");
    const failedDiscard = await f.wait(discarded.capture.id);
    expect(failedDiscard.state).toBe("failed");
    expect((await f.command(failedDiscard, { op: "triage", triage: "discard" })).status).toBe(200);
    const { capture } = await f.create("https://locked.example/");
    const failed = await f.wait(capture.id);
    expect(failed).toMatchObject({ state: "failed", attempt: 1, error: { code: "login_required" } });
    await Bun.sleep(20);
    expect(f.requests.filter(url => url.includes("locked"))).toHaveLength(1);
    const pasted = await readFixture("original.md");
    const retry = await f.command(failed, { op: "retry", content: { format: "markdown", body: pasted } });
    expect(retry.status).toBe(200);
    const ready = await f.wait(capture.id);
    expect(ready).toMatchObject({ state: "ready", attempt: 2, card: "none" });
    expect((await f.original(ready.entity!.id!)).frontmatter.extractor).toBe("pasted@1");
    expect(Source.parse((await f.note(ready.entity!.id!)).frontmatter).status).toBe("to-read");
    expect(f.hub.store.db.query("SELECT attempt FROM inbox_attempts WHERE capture=? ORDER BY attempt").all(ready.id)).toEqual([{ attempt: 1 }, { attempt: 2 }]);
    await f.bind();
    f.modelAttemptsTool();
    await f.command(ready, { op: "summarize", depth: "card" });
    expect(await f.wait(ready.id)).toMatchObject({ state: "ready", card: "failed", error: { code: "summary_failed" } });
    expect(await readdir(join(f.vault, "library/sources"))).toHaveLength(1);
    expect(parseFrontmatter(await readFile(join(f.vault, ready.entity!.path))).data.id).toBe(ready.entity!.id);
  } finally { await f.close(); }
});

test("public fetch limits DNS time, address ranges and both declared and streamed size", async () => {
  for (const value of ["::", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "2002:c0a8:0101::", "169.254.169.254", "100.64.0.1", "224.0.0.1"]) {
    expect(isPublicAddress(value)).toBe(false);
  }
  for (const value of ["93.184.216.34", "2606:4700::1111"]) expect(isPublicAddress(value)).toBe(true);
  const signal = new AbortController().signal;
  const lookup = async () => ["93.184.216.34"];
  await expect(fetchCapture(article, signal, {
    lookup: () => new Promise(() => {}), timeoutMs: 15,
    async request() { throw new Error("unexpected request"); },
  })).rejects.toMatchObject({ code: "timeout" });
  for (const request of [
    async () => response("", 200, { "content-type": "text/html", "content-length": "10485761" }),
    async () => ({ ...response(""), body: (async function* () { yield new Uint8Array(10_485_761); })() }),
  ]) await expect(fetchCapture(article, signal, { lookup, request })).rejects.toMatchObject({ code: "too_large" });
});

test("capture delegates public hostnames to a configured proxy and checks each redirect", async () => {
  const html = await readFixture("article.html");
  const requests: string[] = [], lookups: string[] = [], tunnels: string[] = [];
  const proxy = createServer((request, result) => {
    const url = new URL(request.url!);
    requests.push(url.href);
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers["accept-encoding"]).toBe("identity");
    if (url.pathname === "/start") {
      result.writeHead(302, { Location: "http://next.example/article", "Set-Cookie": "synthetic=secret" }).end();
    } else if (url.pathname === "/internal") {
      result.writeHead(302, { Location: "http://169.254.169.254/" }).end();
    } else if (url.pathname === "/bypass") {
      result.writeHead(302, { Location: "http://sub.direct.example:8080/article" }).end();
    } else {
      result.writeHead(200, { "Content-Type": "text/html" }).end(html);
    }
  });
  proxy.on("connect", (request, socket) => {
    tunnels.push(request.url!);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP proxy");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const env = { HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, NO_PROXY: ".DIRECT.example:8080" };
    const network = {
      ...captureNetwork(env),
      async lookup(host: string) { lookups.push(host); return ["198.18.0.3"]; },
      async request() { throw new Error("Unexpected direct connection"); },
    };
    const signal = new AbortController().signal;
    const fetchUrl = (url: string) => fetchCapture(url, signal, network);

    await expect(fetchUrl("http://proxy-target.example/start")).resolves.toMatchObject({
      url: "http://next.example/article", body: html,
    });
    await expect(fetchUrl("https://tls.example/article")).rejects.toMatchObject({ code: "fetch_failed" });
    expect(tunnels).toEqual(["tls.example:443"]);
    for (const url of ["http://127.0.0.1/", "http://device.local/", "https://localhost/", "http://proxy-target.example/internal"]) {
      await expect(fetchUrl(url)).rejects.toMatchObject({ code: "blocked" });
    }
    expect(lookups).toEqual([]);

    await expect(fetchUrl("http://proxy-target.example/bypass")).rejects.toMatchObject({ code: "blocked" });
    await expect(fetchUrl("http://sub.direct.example/article")).resolves.toMatchObject({ body: html });
    expect(lookups).toEqual(["sub.direct.example"]);
    expect(requests).toEqual([
      "http://proxy-target.example/start", "http://next.example/article", "http://proxy-target.example/internal",
      "http://proxy-target.example/bypass", "http://sub.direct.example/article",
    ]);

    env.NO_PROXY = "*";
    const direct = {
      ...network,
      async lookup() { return ["2606:4700::1111", "93.184.216.34"]; },
      async request(url: URL, address: string) {
        expect(url.href).toBe(article);
        expect(address).toBe("93.184.216.34");
        return response(html);
      },
    };
    await expect(fetchCapture(article, signal, direct)).resolves.toMatchObject({ body: html });
    expect(tunnels).toHaveLength(1);
  } finally {
    const closed = once(proxy, "close");
    proxy.close();
    proxy.closeAllConnections();
    await closed;
  }
});
