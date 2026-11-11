import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIConfigurationDelete, AIConfigurationDeleted, AIConnection, AIConnectionInput, AIProfile, AIProfileInput, ApiError,
  DASHSCOPE_BASE_URLS, NativeSession, SPEECH_LIMITS, SpeechBinding, SpeechBindingUpdate, SpeechStart, SpeechServerMessage,
  SpeechVocabulary, SpeechVocabularyUpdate, WorkProject,
} from "@lumio/schema";
import { backupBusiness } from "@lumio/storage";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";

const key = "synthetic-fun-asr-credential";
const transcript = "synthetic private speech";
const bindings = "/v2/speech/bindings";
const vocabulary = "/v2/speech/vocabulary";
const connectionPath = "/v2/ai/connections";
const profilePath = "/v2/ai/profiles";

async function until(check: () => boolean, timeout = 2500) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Expected event did not arrive");
    await Bun.sleep(5);
  }
}

function mockFunAsr() {
  const lists = new Map<string, { text: string; weight: number }[]>();
  const actions: string[] = [];
  const parameters: Record<string, unknown>[] = [];
  const audio: Buffer[] = [];
  const failure = { remove: false, createResponse: false, stream: false, pending: false };
  let finished = 0;
  let closed = 0;
  const provider = Bun.serve<{ task: string }>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      expect(request.headers.get("Authorization")).toBe("Bearer " + key);
      expect(request.headers.has("X-DashScope-WorkSpace")).toBe(false);
      if (server.upgrade(request, { data: { task: "" } })) return;
      return rest(request);
    },
    websocket: {
      message(ws, frame) {
        const send = (event: string, payload = {}) => ws.send(JSON.stringify({ header: { event, task_id: ws.data.task }, payload }));
        if (typeof frame !== "string") {
          audio.push(frame);
          if (audio.length === 1) {
            send("result-generated", { output: { sentence: { begin_time: 0, text: "synthetic private", sentence_end: false } } });
            send("result-generated", { output: { sentence: { begin_time: 0, text: transcript, sentence_end: true } } });
          }
          return;
        }
        const { header, payload } = JSON.parse(frame);
        expect(header.streaming).toBe("duplex");
        if (header.action === "run-task") {
          ws.data.task = header.task_id;
          expect(payload.model).toBe("fun-asr-realtime");
          parameters.push(payload.parameters);
          if (failure.stream) send("task-failed", { message: key + transcript });
          else send("task-started");
        } else {
          expect(header.action).toBe("finish-task");
          expect(header.task_id).toBe(ws.data.task);
          finished++;
          send("result-generated", { output: { sentence: { begin_time: 1000, text: "末尾", sentence_end: true } } });
          send("task-finished");
        }
      },
      close() { closed++; },
    },
  });
  async function rest(request: Request) {
    const { model, input } = await request.json() as { model: string; input: Record<string, string> };
    expect(model).toBe("speech-biasing");
    const id = input.vocabulary_id!;
    actions.push(input.action!);
    const reply = (output = {}) => Response.json({ output });
    const rejected = () => Response.json({ code: "SyntheticFailure", message: key }, { status: 500 });
    switch (input.action) {
      case "list_vocabulary": return reply({
        vocabulary_list: [...lists.keys()].filter(id => id.startsWith("vocab-" + input.prefix + "-")).map(vocabulary_id => ({ vocabulary_id })),
      });
      case "create_vocabulary": {
        expect(input.target_model).toBe("fun-asr-realtime");
        const created = "vocab-" + input.prefix + "-synthetic";
        expect(lists.has(created)).toBe(false);
        lists.set(created, input.vocabulary as unknown as { text: string; weight: number }[]);
        return failure.createResponse ? rejected() : reply({ vocabulary_id: created });
      }
      case "update_vocabulary": {
        if (!lists.has(id)) return rejected();
        lists.set(id, input.vocabulary as unknown as { text: string; weight: number }[]);
        return reply();
      }
      case "query_vocabulary": return reply({ status: failure.pending ? "UNDEPLOYED" : "OK" });
      case "delete_vocabulary": {
        if (failure.remove || !lists.delete(id)) return rejected();
        return reply();
      }
      default: throw new Error("Unexpected Fun-ASR action");
    }
  }
  return {
    lists, actions, parameters, audio, failure, provider,
    get finished() { return finished; },
    get closed() { return closed; },
    options: {
      fetch: ((url, init) => {
        expect(url).toBe("https://dashscope.aliyuncs.com/api/v1/services/audio/asr/customization");
        return fetch(provider.url, init);
      }) as typeof fetch,
      connect(url: string, headers: Record<string, string>) {
        expect(url).toBe("wss://dashscope.aliyuncs.com/api-ws/v1/inference");
        return new WebSocket(String(provider.url).replace("http:", "ws:"), { headers });
      },
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "lumio-hub-speech-"));
  const mock = mockFunAsr();
  const logs: string[] = [];
  const sockets: WebSocket[] = [];
  const state = await HubStore.open(dir);
  const logPath = join(dir, "hub.log");
  const actors = (["human", "human", "agent", "runtime"] as const).map((role, index) => {
    const actor = state.createActor("synthetic-" + index, role);
    return { actor, token: state.createToken(actor.name, actor.name) };
  });
  const [owner, other, agent, runtime] = actors as [typeof actors[number], typeof actors[number], typeof actors[number], typeof actors[number]];
  state.close();
  const config = { ...readConfig({ LUMIO_STATE_DIR: dir }), port: 0 };
  const hub = await startHub(config, { funAsr: mock.options, log: line => {
    logs.push(line);
    appendFileSync(logPath, line + "\n");
  } });
  const request = (path: string, method = "GET", input?: unknown, token = owner.token, language = "en") =>
    fetch(new URL(path, hub.server.url), {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Accept-Language": language },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
  const connection = AIConnection.parse(await (await request(connectionPath, "POST", AIConnectionInput.parse({
    name: "Synthetic Beijing", host: "hub", kind: "dashscope", base_url: DASHSCOPE_BASE_URLS.beijing, api_key: key,
  }))).json());
  const profile = AIProfile.parse(await (await request(profilePath, "POST", AIProfileInput.parse({
    name: "Synthetic ASR", engine: "speech", model: "fun-asr-realtime", connection: connection.id,
  }))).json());
  const updateBinding = (input: Partial<SpeechBindingUpdate> = {}) => request(bindings, "PUT", SpeechBindingUpdate.parse({
    request_id: crypto.randomUUID(), purpose: "speech.asr", profile: profile.id, ...input,
  }));
  expect(SpeechBinding.parse(await (await updateBinding()).json()).profile).toBe(profile.id);

  function socket(origin = hub.server.url.origin, language = "en") {
    const url = new URL("/v2/speech/transcribe", hub.server.url);
    url.protocol = "ws:";
    const client = new WebSocket(String(url), { headers: { Origin: origin, "Accept-Language": language } });
    sockets.push(client);
    let open = false;
    let closed = false;
    const messages: unknown[] = [];
    client.onopen = () => { open = true; };
    client.onclose = () => { closed = true; };
    client.onmessage = event => { messages.push(JSON.parse(event.data)); };
    return {
      client, get open() { return open; }, get closed() { return closed; },
      waitOpen: () => until(() => open || closed),
      waitClose: (timeout?: number) => until(() => closed, timeout),
      send(value: unknown) { client.send(JSON.stringify(value)); },
      start(token = owner.token, extra: Partial<SpeechStart> = {}) {
        client.send(JSON.stringify(SpeechStart.parse({
          type: "start", protocol: 1, token, request_id: crypto.randomUUID(), format: "pcm16le-16k-mono", ...extra,
        })));
      },
      async next(timeout?: number) {
        await until(() => messages.length > 0 || closed, timeout);
        return SpeechServerMessage.parse(messages.shift());
      },
      messages,
    };
  }
  return { hub, mock, logs, logPath, dir, request, owner, other, agent, runtime, connection, profile, socket, updateBinding,
    async close() {
      for (const socket of sockets) socket.close();
      await hub.stop();
      await mock.provider.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("speech upgrades after Origin validation and authenticates the first frame as a human", async () => {
  const f = await fixture();
  try {
    const denied = f.socket("https://untrusted.example");
    await denied.waitClose();
    expect(denied.open).toBe(false);
    for (const [token, code] of [[f.agent.token, "FORBIDDEN"], [f.runtime.token, "FORBIDDEN"],
      ["synthetic-invalid-token", "UNAUTHENTICATED"], [f.other.token, "NOT_FOUND"]] as const) {
      const client = f.socket();
      await client.waitOpen();
      expect(client.open).toBe(true);
      client.start(token, { profile: f.profile.id });
      expect(await client.next()).toMatchObject({ type: "error", error: { code } });
      await client.waitClose();
    }
    const early = f.socket(undefined, "zh");
    await early.waitOpen();
    early.client.send(new Uint8Array(2));
    expect(await early.next()).toMatchObject({ type: "error", error: { code: "INVALID", message: "请先发送语音开始消息。" } });
    expect(f.mock.parameters).toHaveLength(0);
    const silent = f.socket();
    await silent.waitOpen();
    expect(await silent.next(SPEECH_LIMITS.start_timeout_ms + 2500)).toMatchObject({
      type: "error", error: { code: "UNAUTHENTICATED", reason: "speech-start-timeout" },
    });
    await silent.waitClose();
  } finally { await f.close(); }
}, 12000);

test("speech streams PCM, sends cumulative partials, and finalizes after the provider finishes", async () => {
  const f = await fixture();
  try {
    const client = f.socket();
    await client.waitOpen();
    client.start();
    expect(await client.next()).toMatchObject({ type: "ready", profile: f.profile.id, vocabulary: false });
    expect(f.mock.parameters).toEqual([{ format: "pcm", sample_rate: 16000 }]);
    const audioMarker = "synthetic-pcm-byte-marker";
    const pcm = Buffer.alloc(3200, audioMarker);
    client.client.send(pcm);
    expect(await client.next()).toEqual({ type: "partial", seq: 0, text: "synthetic private" });
    expect(await client.next()).toEqual({ type: "partial", seq: 1, text: transcript });
    expect(f.mock.audio).toEqual([pcm]);
    client.send({ type: "end" });
    expect(await client.next()).toEqual({ type: "partial", seq: 2, text: transcript + " 末尾" });
    expect(await client.next()).toEqual({ type: "final", text: transcript + " 末尾", duration_ms: 100, truncated: false });
    await client.waitClose();
    expect(f.mock.finished).toBe(1);
    const logs = await readFile(f.logPath, "utf8");
    expect(logs).toContain('"outcome":"completed"');
    for (const privateValue of [transcript, audioMarker, key, f.owner.token]) expect(logs).not.toContain(privateValue);
    const backup = join(f.dir, "business-backup");
    const snapshot = await backupBusiness(f.dir, backup);
    const database = await readFile(join(backup, snapshot.database.path));
    for (const privateValue of [transcript, audioMarker, pcm.toString("base64")]) {
      expect(database.includes(privateValue)).toBe(false);
    }
    expect(snapshot.files).toEqual([]);
  } finally { await f.close(); }
});

test("speech enforces session and frame limits, and cancel or disconnect closes the provider", async () => {
  const f = await fixture();
  try {
    const clients = await Promise.all(Array.from({ length: SPEECH_LIMITS.max_sessions_per_actor }, async () => {
      const client = f.socket();
      await client.waitOpen();
      client.start();
      expect((await client.next()).type).toBe("ready");
      return client;
    }));
    const extra = f.socket();
    await extra.waitOpen();
    extra.start();
    expect(await extra.next()).toMatchObject({ type: "error", error: { reason: "speech-session-limit" } });
    clients[0]!.send({ type: "cancel" });
    clients[1]!.client.close();
    await until(() => f.mock.closed === clients.length);
    expect(f.mock.finished).toBe(0);
    for (const size of [1, SPEECH_LIMITS.max_frame_bytes + 2]) {
      const client = f.socket();
      await client.waitOpen();
      client.start();
      expect((await client.next()).type).toBe("ready");
      client.client.send(new Uint8Array(size));
      expect(await client.next()).toMatchObject({ type: "error", error: { reason: "speech-invalid-frame" } });
      await client.waitClose();
    }
    expect(f.mock.audio).toHaveLength(0);
    f.mock.failure.stream = true;
    const failed = f.socket();
    await failed.waitOpen();
    failed.start();
    expect(await failed.next()).toEqual({ type: "error", error: {
      code: "INTERNAL", reason: "speech-provider-failed", message: "Fun-ASR could not complete speech recognition.",
    } });
  } finally { await f.close(); }
});

test("speech idle timeout finalizes and closes with truncated=true", async () => {
  const f = await fixture();
  try {
    const client = f.socket();
    await client.waitOpen();
    client.start();
    expect((await client.next()).type).toBe("ready");
    expect((await client.next(SPEECH_LIMITS.idle_timeout_ms + 3000)).type).toBe("partial");
    expect(await client.next()).toEqual({ type: "final", text: "末尾", duration_ms: 0, truncated: true });
    await client.waitClose();
    expect(f.mock.finished).toBe(1);
  } finally { await f.close(); }
}, 16000);

test("vocabulary is scoped, merges live Work titles, syncs at weight four and recovers a lost create response", async () => {
  const f = await fixture();
  try {
    const project = WorkProject.parse({
      schema_version: 2, type: "project", id: "prj_00000000000000000000000001", title: "Lumio",
      description: "synthetic private description", status: "active", revision: 1,
      created: new Date().toISOString(), updated: new Date().toISOString(), tags: [],
    });
    f.hub.modules.workStore.putProject(project);
    f.hub.modules.workStore.putProject({ ...project, id: "prj_00000000000000000000000002", title: "a b c d e f g h" });
    const initial = SpeechVocabulary.parse(await (await f.request(vocabulary)).json());
    expect(initial.terms).toEqual([]);
    const put = SpeechVocabularyUpdate.parse({
      request_id: crypto.randomUUID(), expected_revision: initial.revision, terms: ["citekey", "中英混说"], include_project_names: true,
    });
    f.mock.failure.createResponse = true;
    const failed = SpeechVocabulary.parse(await (await f.request(vocabulary, "PUT", put, f.owner.token, "zh")).json());
    expect(failed.sync).toMatchObject([{ state: "error", error: "未能将词表同步到 Fun-ASR。" }]);
    expect(f.mock.lists.size).toBe(1);
    f.mock.failure.createResponse = false;
    const synced = SpeechVocabulary.parse(await (await f.request(vocabulary, "PUT", put)).json());
    expect(synced.revision).toBe(initial.revision + 1);
    expect(synced.sync).toMatchObject([{ connection: f.connection.id, state: "synced", revision: synced.revision }]);
    expect(synced.terms).toEqual(put.terms);
    expect([...f.mock.lists.values()]).toEqual([[{ text: "citekey", weight: 4 }, { text: "中英混说", weight: 4 }, { text: "Lumio", weight: 4 }]]);
    expect(JSON.stringify(synced)).not.toContain("vocab-");
    expect((await f.request(vocabulary, "PUT", { ...put, terms: ["different"] })).status).toBe(409);
    expect((await f.request(vocabulary, "PUT", { ...put, terms: Array.from({ length: 201 }, (_, i) => String(i)) })).status).toBe(400);
    expect((await f.request(vocabulary, "GET", undefined, f.agent.token)).status).toBe(403);
    expect(SpeechVocabulary.parse(await (await f.request(vocabulary, "GET", undefined, f.other.token)).json()).terms).toEqual([]);
    const client = f.socket();
    await client.waitOpen();
    client.start();
    expect(await client.next()).toMatchObject({ type: "ready", vocabulary: true });
    expect(f.mock.parameters[0]?.vocabulary_id).toBe([...f.mock.lists.keys()][0]);
    client.send({ type: "cancel" });
  } finally { await f.close(); }
});

test("configuration deletion protects references, unbinds speech and retries remote cleanup with the local key intact", async () => {
  const f = await fixture();
  try {
    const connectionUrl = connectionPath + "/" + f.connection.id;
    const profileUrl = profilePath + "/" + f.profile.id;
    const deleteConnection = AIConfigurationDelete.parse({ request_id: crypto.randomUUID(), expected_revision: f.connection.revision });
    const deleteProfile = AIConfigurationDelete.parse({ request_id: crypto.randomUUID(), expected_revision: f.profile.revision });
    expect((await f.request(connectionUrl, "DELETE", deleteConnection, f.runtime.token)).status).toBe(403);
    expect((await f.request(profileUrl, "DELETE", deleteProfile, f.other.token)).status).toBe(404);
    expect((await f.request(connectionUrl, "DELETE", deleteConnection)).status).toBe(409);
    expect((await f.request(profileUrl, "DELETE", { ...deleteProfile, expected_revision: f.profile.revision + 1 })).status).toBe(409);
    expect((await f.request(profileUrl, "DELETE", { ...deleteProfile, cascade: true })).status).toBe(400);
    const initial = SpeechVocabulary.parse(await (await f.request(vocabulary)).json());
    expect((await f.request(vocabulary, "PUT", SpeechVocabularyUpdate.parse({
      request_id: crypto.randomUUID(), expected_revision: initial.revision, terms: ["Lumio"], include_project_names: false,
    }))).status).toBe(200);
    expect(f.mock.lists.size).toBe(1);
    expect(AIConfigurationDeleted.parse(await (await f.request(profileUrl, "DELETE", deleteProfile)).json())).toEqual({ id: f.profile.id, deleted: true });
    expect(SpeechBinding.array().parse(await (await f.request(bindings)).json())).toEqual([]);
    expect((await f.updateBinding({ expected_revision: 1 })).status).toBe(409);
    const noBinding = f.socket();
    await noBinding.waitOpen();
    noBinding.start();
    expect(await noBinding.next()).toMatchObject({ type: "error", error: { reason: "speech-binding-missing" } });
    f.mock.failure.remove = true;
    const failed = await f.request(connectionUrl, "DELETE", deleteConnection);
    expect(failed.status).toBe(500);
    expect(ApiError.parse(await failed.json()).error.message).not.toContain(key);
    expect(f.hub.modules.ai.store.secret(f.connection.id)).toBe(key);
    f.mock.failure.remove = false;
    const expected = { id: f.connection.id, deleted: true } as const;
    expect(AIConfigurationDeleted.parse(await (await f.request(connectionUrl, "DELETE", deleteConnection)).json())).toEqual(expected);
    expect(f.mock.lists.size).toBe(0);
    expect(f.hub.modules.ai.store.secret(f.connection.id)).toBeUndefined();
    expect(AIConfigurationDeleted.parse(await (await f.request(connectionUrl, "DELETE", deleteConnection)).json())).toEqual(expected);
    expect((await f.request(connectionUrl, "DELETE", { ...deleteConnection, expected_revision: f.connection.revision + 1 })).status).toBe(409);
    expect(f.logs.join("\n")).not.toContain(key);
  } finally { await f.close(); }
});

test("speech caps forwarded PCM at the utterance limit and closes even if the client keeps sending", async () => {
  const f = await fixture();
  try {
    const client = f.socket();
    await client.waitOpen();
    client.start();
    expect((await client.next()).type).toBe("ready");
    const audioLimit = SPEECH_LIMITS.max_utterance_seconds * SPEECH_LIMITS.sample_rate * 2;
    const frame = new Uint8Array(SPEECH_LIMITS.max_frame_bytes);
    for (let sent = 0; sent < audioLimit + frame.length; sent += frame.length) {
      if (client.closed) break;
      client.client.send(frame);
      if (sent % (4 * frame.length) === 0) await Bun.sleep(1);
    }
    expect((await client.next()).type).toBe("partial");
    expect((await client.next()).type).toBe("partial");
    expect((await client.next()).type).toBe("partial");
    expect(await client.next()).toMatchObject({ type: "final", duration_ms: 120000, truncated: true });
    await client.waitClose();
    expect(f.mock.audio.reduce((sum, frame) => sum + frame.length, 0)).toBe(audioLimit);
  } finally { await f.close(); }
});

test("speech bindings validate purpose, support revisioned unbinding and reject foreign profiles", async () => {
  const f = await fixture();
  try {
    const tts = AIProfile.parse(await (await f.request(profilePath, "POST", AIProfileInput.parse({
      name: "Synthetic TTS", engine: "speech", model: "cosyvoice-v3-flash", connection: f.connection.id,
    }))).json());
    expect((await f.updateBinding({ purpose: "speech.tts" })).status).toBe(400);
    expect((await f.updateBinding({ profile: tts.id })).status).toBe(400);
    const put = SpeechBindingUpdate.parse({ request_id: crypto.randomUUID(), purpose: "speech.tts", profile: tts.id });
    expect((await f.request(bindings, "PUT", put, f.other.token)).status).toBe(404);
    expect((await f.request(bindings, "PUT", put, f.agent.token)).status).toBe(403);
    const bound = SpeechBinding.parse(await (await f.request(bindings, "PUT", put)).json());
    expect(bound).toEqual({ purpose: "speech.tts", profile: tts.id, revision: 1 });
    const clear = SpeechBindingUpdate.parse({ ...put, request_id: crypto.randomUUID(), expected_revision: bound.revision, profile: null });
    expect(await (await f.request(bindings, "PUT", clear)).json()).toBeNull();
    expect(await (await f.request(bindings, "PUT", clear)).json()).toBeNull();
    expect(SpeechBinding.array().parse(await (await f.request(bindings)).json())).toEqual([
      { purpose: "speech.asr", profile: f.profile.id, revision: 1 },
    ]);
  } finally { await f.close(); }
});


test("profile deletion preserves a closed native session snapshot and protects unknown sessions", async () => {
  const f = await fixture();
  try {
    const connection = AIConnection.parse(await (await f.request(connectionPath, "POST", AIConnectionInput.parse({
      name: "Synthetic native", kind: "codex-account", host: f.runtime.actor.name,
    }))).json());
    const profile = AIProfile.parse(await (await f.request(profilePath, "POST", AIProfileInput.parse({
      name: "Synthetic native", engine: "codex", model: "default", connection: connection.id,
    }))).json());
    const session = NativeSession.parse({
      id: "ais_00000000000000000000000001", conversation: "conv_00000000000000000000000001",
      owner: f.owner.actor.id, runtime: f.runtime.actor.id, profile, connection,
      binding: { profile: profile.id, purpose: "assistant", revision: 1, workdir: "managed-session",
        approval_policy: "on-request", reviewer: "user", sandbox: "workspace-write", command_network: false,
        tools: [], timeout_seconds: 60 },
      view: { state: "unknown" }, sequence: 1, created: profile.created, updated: profile.updated,
      quarantined: true, context_revision: "synthetic", capabilities: [],
    });
    const ai = f.hub.modules.ai.store;
    ai.putSession(session);
    const remove = (path: string, value: AIConnection | AIProfile) => f.request(path + "/" + value.id, "DELETE",
      AIConfigurationDelete.parse({ request_id: crypto.randomUUID(), expected_revision: value.revision }));
    expect((await remove(profilePath, profile)).status).toBe(409);
    const closed = NativeSession.parse({ ...session, view: { state: "closed" }, quarantined: false });
    ai.putSession(closed);
    expect((await remove(profilePath, profile)).status).toBe(200);
    expect((await remove(connectionPath, connection)).status).toBe(200);
    expect(ai.session(session.id)).toEqual(closed);
  } finally { await f.close(); }
});
