import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, CAPABILITIES, KnowledgeGraph } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";

test("human graph endpoint validates strict filters, private edges and role restrictions without joining the agent catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-k3-http-")), vault = join(root, "vault");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), vault, { recursive: true });
  await cp(new URL("../../../fixtures/knowledge-graph", import.meta.url), vault, { recursive: true });
  const hub = await startHub({ ...readConfig({ HOME: root, LUMIO_VAULT: vault, LUMIO_STATE_DIR: join(root, "state") }), port: 0 }, { log() {} });
  try {
    const tokens: Record<string, string> = {};
    for (const role of ["human", "agent", "runtime"] as const) { hub.store.createActor(role, role); tokens[role] = hub.store.createToken(role, role); }
    const call = (query = "", role = "human") => fetch(new URL("/v2/knowledge/graph" + query, hub.server.url), { headers: { Authorization: `Bearer ${tokens[role]}` } });
    const response = await call(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const publicGraph = KnowledgeGraph.parse(await response.json());
    expect(publicGraph.nodes.some(n => n.title === "Synthetic graph hub")).toBe(true);
    expect(publicGraph.nodes.some(n => ["asset", "task", "project", "routine"].includes(n.type))).toBe(false);
    const all = KnowledgeGraph.parse(await (await call("?include_private=true&include_legacy=true")).json());
    expect(all.nodes.some(n => n.type === "asset")).toBe(true); expect(all.nodes.some(n => n.type === "task")).toBe(true);
    const ideas = KnowledgeGraph.parse(await (await call("?type=idea")).json());
    expect(ideas.nodes.every(n => n.type === "idea")).toBe(true);
    expect(ideas.edges.every(e => ideas.nodes.some(n => n.path === e.from) && ideas.nodes.some(n => n.path === e.to))).toBe(true);
    for (const role of ["agent", "runtime"]) for (const query of ["", "?include_private=true"]) {
      const denied = await call(query, role); expect(denied.status).toBe(403); expect(ApiError.parse(await denied.json()).error.code).toBe("FORBIDDEN");
    }
    for (const query of ["?include_private=1", "?include_legacy=maybe", "?type=unknown", "?unknown=true"]) expect((await call(query)).status).toBe(400);
    expect((await fetch(new URL("/v2/knowledge/graph", hub.server.url))).status).toBe(401);
    expect(CAPABILITIES.some(c => c.name === ("knowledge.graph" as string))).toBe(false);
  } finally { await hub.stop(); await rm(root, { recursive: true, force: true }); }
});

test("graph explicitly rejects agents even under an injected permissive rule; missing vault reports INVALID", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-k3-no-vault-"));
  const hub = await startHub({ ...readConfig({ HOME: root, LUMIO_STATE_DIR: join(root, "state") }), port: 0 }, { log() {}, authorize: () => ({ result: "allow" }) });
  try {
    for (const role of ["human", "agent", "runtime"] as const) {
      hub.store.createActor(role, role); const token = hub.store.createToken(role, role);
      const r = await fetch(new URL("/v2/knowledge/graph", hub.server.url), { headers: { Authorization: `Bearer ${token}` } });
      expect(r.status).toBe(role === "human" ? 400 : 403);
    }
  } finally { await hub.stop(); await rm(root, { recursive: true, force: true }); }
});
