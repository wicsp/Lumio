import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIConfiguration, AIConnection, AIConnectionInput, AIProfileInput, ApiError, TYPESAFE_JEV_BASE_URL } from "@lumio/schema";
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
    async request(path: string, body?: unknown, language = "en", bearer = token, method = body === undefined ? "GET" : "POST") {
      return fetch(new URL(path, hub.server.url), {
        method,
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

test("Jev connections stay owner-scoped and keep credentials private on create and edit", async () => {
  const f = await fixture();
  try {
    const key = "${secret:synthetic-jev}";
    const input = AIConnectionInput.parse({
      name: "Synthetic Jev", kind: "typesafe-jev", host: "hub", base_url: TYPESAFE_JEV_BASE_URL, api_key: key,
    });
    const path = "/v2/ai/connections";
    for (const [attempt, reason] of [
      [{ ...input, base_url: "https://fixture.example.test/v1" }, "ai-jev-address"],
      [{ ...input, api_key: undefined }, "ai-jev-key-required"],
    ] as const) {
      const response = await f.request(path, attempt);
      expect(response.status).toBe(400);
      expect(ApiError.parse(await response.json()).error.reason).toBe(reason);
    }
    const created = await f.request(path, input);
    expect(created.status).toBe(200);
    const view = AIConnection.parse(await created.json());
    expect(view).toMatchObject({ kind: "typesafe-jev", host: "hub", base_url: TYPESAFE_JEV_BASE_URL, api_key_set: true });
    const existingPath = `${path}/${view.id}`;
    const rename = AIConnectionInput.parse({ ...input, name: "Renamed Jev", api_key: undefined });
    const updated = await f.request(existingPath, rename, "en", undefined, "PUT");
    expect(updated.status).toBe(200);
    expect(AIConnection.parse(await updated.json())).toMatchObject({ id: view.id, name: rename.name, revision: view.revision + 1, api_key_set: true });
    expect(f.hub.modules.ai.store.secret(view.id)).toBe(key);

    const cleared = await f.request(existingPath, { ...rename, clear_api_key: true }, "en", undefined, "PUT");
    expect(cleared.status).toBe(400);
    expect(ApiError.parse(await cleared.json()).error.reason).toBe("ai-jev-key-required");
    const replacement = "${secret:synthetic-jev-rotated}";
    const rotated = await f.request(existingPath, AIConnectionInput.parse({ ...rename, api_key: replacement }), "en", undefined, "PUT");
    expect(rotated.status).toBe(200);
    expect(AIConnection.parse(await rotated.json()).api_key_set).toBe(true);
    expect(f.hub.modules.ai.store.secret(view.id)).toBe(replacement);

    const config = AIConfiguration.parse(await (await f.request("/v2/ai/config")).json());
    expect(config.connections.map(connection => connection.kind).sort()).toEqual(["deepseek", "typesafe-jev"]);
    expect(config.profiles).toHaveLength(1);
    expect(JSON.stringify(config)).not.toContain(key);
    expect(JSON.stringify(config)).not.toContain(replacement);
    expect(f.logs.join("\n")).not.toContain(key);
    expect(f.logs.join("\n")).not.toContain(replacement);

    const other = f.hub.store.createActor("jev-other-owner", "human");
    const otherToken = f.hub.store.createToken("jev-other-owner", other.name);
    const foreign = await f.request("/v2/ai/config", undefined, "en", otherToken);
    expect(AIConfiguration.parse(await foreign.json())).toEqual({ connections: [], profiles: [] });
    const foreignEdit = await f.request(existingPath, rename, "en", otherToken, "PUT");
    expect(foreignEdit.status).toBe(404);
    expect(ApiError.parse(await foreignEdit.json()).error.reason).toBe("ai-connection-missing");
    expect((await f.request(path, input, "en", f.agentToken)).status).toBe(403);

    const profile = AIProfileInput.parse({ name: "Synthetic", connection: view.id, engine: "lumio", model: "jev-latest" });
    const profilePath = "/v2/ai/profiles";
    for (const response of [
      await f.request(profilePath, profile),
      await f.request(`${profilePath}/${config.profiles[0]!.id}`, profile, "en", undefined, "PUT"),
    ]) {
      expect(response.status).toBe(400);
      expect(ApiError.parse(await response.json()).error.reason).toBe("ai-jev-chat-unsupported");
    }
    const after = AIConfiguration.parse(await (await f.request("/v2/ai/config")).json());
    expect(after.profiles).toEqual(config.profiles);
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
