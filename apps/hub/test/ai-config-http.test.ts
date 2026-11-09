import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIConfiguration, AIConnection, ApiError } from "@lumio/schema";
import { HubStore } from "../src/store.ts";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "lumio-ai-config-"));
  const store = await HubStore.open(dir);
  const owner = store.createActor("synthetic-owner", "human");
  const token = store.createToken("synthetic-owner", owner.name);
  const agent = store.createActor("synthetic-agent", "agent");
  const agentToken = store.createToken("synthetic-agent", agent.name);
  store.close();
  const logs: string[] = [];
  const config = {
    ...readConfig({ LUMIO_STATE_DIR: dir }),
    port: 0,
    assistantModel: {
      baseUrl: "https://api.deepseek.com/v1",
      model: "synthetic-model",
      credential: () => "SYNTHETIC_PRIVATE_KEY",
    },
  };
  let hub: Awaited<ReturnType<typeof startHub>>;
  try {
    hub = await startHub(config, { log: (line) => logs.push(line) });
  } catch (cause) {
    await rm(dir, { recursive: true, force: true });
    throw cause;
  }
  return {
    hub,
    logs,
    owner,
    async request(path: string, body?: unknown, language = "en", bearer = token) {
      return fetch(new URL(path, hub.server.url), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          "Accept-Language": language,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    agentToken,
    async close() {
      await hub.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Hub migrates legacy settings before requests, while concurrent config GETs stay read-only", async () => {
  const f = await fixture();
  try {
    const initial = f.hub.modules.ai.list(f.owner.id);
    expect(initial.connections).toHaveLength(1);
    expect(initial.profiles).toHaveLength(1);
    const before = f.hub.store.db.query("SELECT * FROM ai_receipts").all();
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        const response = await f.request("/v2/ai/config");
        expect(response.status).toBe(200);
        expect(AIConfiguration.parse(await response.json())).toEqual(initial);
      }),
    );
    expect(f.hub.store.db.query("SELECT * FROM ai_receipts").all()).toEqual(before);
    expect((await f.request("/v2/ai/config", undefined, "en", f.agentToken)).status).toBe(403);
    const lateOwner = f.hub.store.createActor("synthetic-late-owner", "human");
    const lateToken = f.hub.store.createToken("synthetic-late-owner", lateOwner.name);
    const late = await f.request("/v2/ai/config", undefined, "en", lateToken);
    expect(AIConfiguration.parse(await late.json())).toEqual({ connections: [], profiles: [] });
    expect(JSON.stringify(initial)).not.toContain("SYNTHETIC_PRIVATE_KEY");
    expect(f.logs.join("\n")).not.toContain("SYNTHETIC_PRIVATE_KEY");
  } finally {
    await f.close();
  }
});

test("AI configuration HTTP errors name the problem in either language without echoing secrets", async () => {
  const f = await fixture();
  try {
    const connection = f.hub.modules.ai.list(f.owner.id).connections[0]!;
    const profile = {
      name: "Synthetic",
      connection: connection.id,
      engine: "lumio",
      model: "synthetic-model",
      thinking: "default",
    };
    const cases = [
      { input: { ...profile, effort: "ultra" }, reason: "ai-effort-unsupported", en: "effort", zh: "思考档位" },
      { input: { ...profile, engine: "codex" }, reason: "ai-engine-mismatch", en: "engine", zh: "引擎" },
      { input: { ...profile, model: "" }, reason: "ai-model", en: "model ID", zh: "模型 ID" },
      { input: { ...profile, name: "SYNTHETIC_PRIVATE_KEY" }, reason: "ai-credential", en: "API key", zh: "API 密钥" },
    ];
    for (const c of cases)
      for (const lang of ["en", "zh"] as const) {
        const response = await f.request("/v2/ai/profiles", c.input, lang);
        expect(response.status).toBe(400);
        const error = ApiError.parse(await response.json()).error;
        expect(error.code).toBe("INVALID");
        expect(error.reason).toBe(c.reason);
        expect(error.message).toContain(c[lang]);
        expect(JSON.stringify(error)).not.toContain("SYNTHETIC_PRIVATE_KEY");
      }
    const invalid = await f.request("/v2/ai/connections", {
      name: "Synthetic",
      kind: "deepseek",
      host: "hub",
      base_url: "ftp://synthetic.example.test",
    });
    expect(ApiError.parse(await invalid.json()).error.reason).toBe("ai-address");
    const response = await f.request("/v2/ai/connections", {
      name: "Synthetic API",
      kind: "openai-compatible",
      host: "hub",
      base_url: "https://synthetic.example.test/v1",
    });
    const api = AIConnection.parse(await response.json());
    const thinking = await f.request("/v2/ai/profiles", { ...profile, connection: api.id, thinking: "on" });
    expect(ApiError.parse(await thinking.json()).error.reason).toBe("ai-thinking-unsupported");
    const other = f.hub.store.createActor("synthetic-other", "human");
    const otherToken = f.hub.store.createToken("synthetic-other", other.name);
    const unavailable = await f.request("/v2/ai/profiles", profile, "en", otherToken);
    expect(unavailable.status).toBe(404);
    expect(ApiError.parse(await unavailable.json()).error.reason).toBe("ai-connection-missing");
  } finally {
    await f.close();
  }
});
