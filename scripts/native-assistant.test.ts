import { homedir,tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, readFile, copyFile, chmod, stat,realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startHub } from "../apps/hub/src/server.ts";
import { readConfig } from "../apps/hub/src/config.ts";
import { createClient } from "../packages/api-client/src/index.ts";
import { NativeRuntimeCommand, NativeSession, WorkCommandResult, type NativeRuntimeMessage } from "../packages/schema/src/index.ts";
import { NativeManager } from "../apps/runtime/src/native/manager.ts";
import { NativeLocalStore } from "../apps/runtime/src/native/store.ts";
async function until<T>(get: () => Promise<T> | T, predicate: (v: T) => boolean, timeout = 10000) { const end = Date.now() + timeout; let last: T; while (Date.now() < end) {
    last = await get();
    if (predicate(last))
        return last;
    await Bun.sleep(20);
} throw new Error("Synthetic condition timed out"); }
async function fixture(options: {
    official?: boolean;
} = {}) {
    const root = await mkdtemp(join(await realpath(tmpdir()),"lumio-native-integration-"));
    const state = join(root, "hub"), local = join(root, "runtime");
    await mkdir(local);
    const config = readConfig({ LUMIO_STATE_DIR: state, LUMIO_HUB_LISTEN: "127.0.0.1:0" });
    const hub = await startHub(config, { log: () => { }, assistantHome: join(root, "home") });
    const owner = hub.store.createActor("synthetic-human", "human"), token = hub.store.createToken("synthetic-human", owner.name);
    const actor = hub.store.createActor("synthetic-runtime", "runtime"), runtimeToken = hub.store.createToken("synthetic-runtime", actor.name);
    const url = `http://127.0.0.1:${hub.server.port}`, client = createClient({ url, token });
    const registration = await fetch(`${url}/v1/runtime/register`, { method: "POST", headers: { Authorization: `Bearer ${runtimeToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ protocol_version: 2, name: "synthetic-runtime", engines: [{ name: "codex", version: "0.166.0", sandbox: "os" }], tags: [], max_concurrent: 2 }) });
    expect(registration.ok).toBe(true);
    const store = new NativeLocalStore(local);
    let channel: string | undefined, abort: AbortController | undefined, reading: Promise<void> | undefined, flushing = false, pendingFlush = false;
    const post = async (value: unknown) => { const r = await fetch(`${url}/v2/runtime/native/events`, { method: "POST", headers: { Authorization: `Bearer ${runtimeToken}`, "Content-Type": "application/json", "X-Lumio-Native-Channel": channel ?? "" }, body: JSON.stringify(value) }); if (!r.ok)
        throw new Error("Synthetic channel failed"); };
    const flush = () => { pendingFlush = true; if (flushing || !channel)
        return; flushing = true; void (async () => { try {
        do {
            pendingFlush = false;
            for (const e of store.events())
                await post(e);
        } while (pendingFlush && channel);
    }
    catch { }
    finally {
        flushing = false;
    } })(); };
    const fake = resolve("fixtures/native/fake-codex.ts"), manager = new NativeManager(store, local, flush, { runtimeName: "synthetic-runtime", ...(options.official ? { mcp: { command: process.execPath, args: [resolve("apps/runtime/src/main.ts"), "native-mcp"] } } : { codex: fake, unsafeTestCommand: [process.execPath, fake] }) });
    const connect = async () => {
        abort = new AbortController();
        const response = await fetch(`${url}/v2/runtime/native`, { headers: { Authorization: `Bearer ${runtimeToken}` }, signal: abort.signal });
        channel = response.headers.get("x-lumio-native-channel")!;
        reading = (async () => { const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = ""; try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                buffer += decoder.decode(chunk.value, { stream: true });
                let end: number;
                while ((end = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, end);
                    buffer = buffer.slice(end + 1);
                    if (line.trim()) {
                        const c = NativeRuntimeCommand.parse(JSON.parse(line));
                        if (options.official && c.type === "open") {
                            const home = join(local, "native", c.session.id, "codex");
                            await mkdir(home, { recursive: true, mode: 0o700 });
                            const auth = join(home, "auth.json");
                            if (!await stat(auth).catch(() => undefined)) {
                                await copyFile(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), auth);
                                await chmod(auth, 0o600);
                            }
                        }
                        await manager.receive(c);
                    }
                }
            }
        }
        catch { }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        } })();
        await post({ type: "hello", protocol: 1, instance: "synthetic-runtime-instance", version: "1", isolation: "macos-seatbelt" });
        await until(() => client.aiRuntimes(), r => r.some(v => v.online));
    };
    await connect();
    const connection = await client.saveAIConnection({ name: "Synthetic Codex", kind: "codex-account", host: "synthetic-runtime" }), profile = await client.saveAIProfile({ name: "Synthetic profile", connection: connection.id, engine: "codex", model: "default", thinking: "default" });
    const create = async () => { const s = NativeSession.parse(await client.createNativeSession({ request_id: `synthetic-create-${crypto.randomUUID()}`, profile: profile.id }).catch(e => { throw e; })); return until(() => client.nativeSession(s.id), v => v.view.state === "ready"); };
    const close = async () => { await manager.stop(); channel = undefined; abort?.abort(); await reading; await hub.stop(); store.close(); await rm(root, { recursive: true, force: true }); };
    return { root, local, hub, client, profile, connection, create, close, store, manager, url, owner, connect };
}
test("native conversation keeps one official thread, dynamic model settings, idempotency and owner boundary", async () => {
    const f = await fixture();
    try {
        const s = await f.create();
        expect(s.view.models[0]?.efforts).toContain("medium");
        const input = { request_id: "synthetic-native-first-1234", conversation: s.conversation, message: "REMEMBER SYNTHETIC_CODE" };
        expect((await f.client.assistantChat(input)).turn.status).toBe("done");
        const repeated = await f.client.assistantChat(input);
        expect(repeated.turn.status).toBe("done");
        const result = await f.client.assistantChat({ request_id: "synthetic-native-second-1234", conversation: s.conversation, message: "RECALL", model: "gpt-6.1-terra", effort: "medium" });
        expect(result.messages.some(m => m.content === "SYNTHETIC_CODE")).toBe(true);
        const saved = JSON.parse(await readFile(join(f.local, "native", s.id, "codex/fixture-state.json"), "utf8"));
        expect(saved.calls).toBe(2);
        const foreign = f.hub.store.createActor("synthetic-other", "human"), token = f.hub.store.createToken("synthetic-other", foreign.name);
        const other = createClient({ url: f.url, token });
        await expect(other.nativeSession(s.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
        const events = await f.client.nativeEvents(s.id);
        expect(new Set(events.map(e => e.sequence)).size).toBe(events.length);
        expect(events.some(e => e.event.type === "reasoning")).toBe(true);
    }
    finally {
        await f.close();
    }
}, 20000);
test("native approvals bind to the original instance and are never permanent rules", async () => {
    const f = await fixture();
    try {
        const s = await f.create();
        const result = f.client.assistantChat({ request_id: "synthetic-approval-round-1234", conversation: s.conversation, message: "APPROVE" });
        const pending = await until(() => f.client.nativeSession(s.id), s => !!s.view.approval);
        const a = pending.view.approval!;
        await expect(f.client.nativeAction(s.id, { action: "approval", approval: a.id, instance: "wrong-instance", accept: true })).rejects.toMatchObject({ code: "CONFLICT" });
        await f.client.nativeAction(s.id, { action: "approval", approval: a.id, instance: a.instance, accept: true });
        expect((await result).turn.status).toBe("done");
        await expect(f.client.nativeAction(s.id, { action: "approval", approval: a.id, instance: a.instance, accept: true })).rejects.toMatchObject({ code: "CONFLICT" });
        const saved = JSON.parse(await readFile(join(f.local, "native", s.id, "codex/fixture-state.json"), "utf8"));
        expect(saved.approvals).toBe(1);
    }
    finally {
        await f.close();
    }
}, 20000);
test("lost turn acceptance becomes unknown, does not replay, and blocks replacement sessions", async () => {
    const f = await fixture();
    try {
        const s = await f.create();
        const result = await f.client.assistantChat({ request_id: "synthetic-lost-accept-1234", conversation: s.conversation, message: "NO_ACK" });
        expect(result.turn.status).toBe("unknown");
        const state = await until(() => f.client.nativeSession(s.id), v => v.quarantined);
        expect(state.view.state).toBe("unknown");
        await expect(f.client.assistantChat({ request_id: "synthetic-after-unknown-1234", conversation: s.conversation, message: "Do not repeat" })).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(f.create()).rejects.toMatchObject({ code: "CONFLICT" });
        const saved = JSON.parse(await readFile(join(f.local, "native", s.id, "codex/fixture-state.json"), "utf8"));
        expect(saved.calls).toBe(1);
    }
    finally {
        await f.close();
    }
}, 20000);
test("native session credentials cannot authorize normal human or runtime endpoints", async () => {
    const f = await fixture();
    try {
        const s = await f.create(), token = f.store.get(s.id)!.token;
        const response = await fetch(`${f.url}/v2/work/tasks`, { headers: { Authorization: `Bearer ${token}` } });
        expect(response.status).toBe(401);
        const tools = await fetch(`${f.url}/v2/native-mcp/${s.id}/tools`, { headers: { Authorization: `Bearer ${token}` } });
        expect(tools.ok).toBe(true);
        const call = await fetch(`${f.url}/v2/native-mcp/${s.id}/call`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ request_id: "synthetic-unbound-tool-1234", tool: "work_task_list", args: {} }) });
        expect(call.status).toBe(403);
    }
    finally {
        await f.close();
    }
}, 20000);
test.skipIf(process.env.LUMIO_NATIVE_LIVE !== "1")("official Codex: protected environment, native history recovery, and real Lumio MCP", async () => {
    const f = await fixture({ official: true });
    try {
        const s = await f.create();
        expect(s.view.version).toBe("codex-cli 0.166.0");
        const first = await f.client.assistantChat({ request_id: "live-synthetic-native-first-1234", conversation: s.conversation, message: "Remember the synthetic codeword SYNTHETIC_NATIVE. Reply only ACK. Do not use tools." });
        expect(first.turn.status).toBe("done");
        await f.manager.disconnect();
        await until(() => f.client.nativeSession(s.id), s => s.view.state === "offline");
        await f.client.nativeAction(s.id, { action: "resume" });
        const resumed = await until(() => f.client.nativeSession(s.id), s => s.view.state === "ready");
        expect(resumed.view.thread).toBe(s.view.thread);
        const second = await f.client.assistantChat({ request_id: "live-synthetic-native-second-1234", conversation: s.conversation, message: "Reply only the synthetic codeword from before. Do not use tools." });
        expect(second.messages.some(m => m.role === "assistant" && m.content.includes("SYNTHETIC_NATIVE"))).toBe(true);
        let pending = true;
        const seen = new Set<string>();
        const approver = (async () => { while (pending) {
            const view = await f.client.nativeSession(s.id);
            const a = view.view.approval;
            if (a && !seen.has(a.id)) {
                seen.add(a.id);
                await f.client.nativeAction(s.id, { action: "approval", approval: a.id, instance: a.instance, accept: a.method === "mcp" });
            }
            await Bun.sleep(100);
        } })();
        try {
            const result = await f.client.assistantChat({ request_id: "live-synthetic-native-mcp-1234", conversation: s.conversation, message: "Use the Lumio work__task__list MCP tool with empty arguments once, then reply only SYNTHETIC_MCP_OK. Do not use shell, files, or any write tool." });
            expect(result.turn.status).toBe("done");
            expect(f.hub.modules.assistantStore.calls(result.turn.id).some(c => c.capability === "work.task.list" && c.status === "succeeded")).toBe(true);
        }
        finally {
            pending = false;
            await approver;
        }
    }
    finally {
        await f.close();
    }
}, 180000);
test("native MCP writes have durable receipts and retain ordinary agent permissions", async () => {
    const f = await fixture();
    try {
        const s = await f.create();
        const pending = f.client.assistantChat({ request_id: "synthetic-mcp-active-1234", conversation: s.conversation, message: "WAIT" });
        await until(() => f.client.nativeSession(s.id), s => s.view.state === "running");
        const token = f.store.get(s.id)!.token;
        const invoke = (request_id: string, tool: string, args: unknown) => fetch(`${f.url}/v2/native-mcp/${s.id}/call`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ request_id, tool, args }) });
        const request = "synthetic-mcp-once-1234", args = { title: "SYNTHETIC_NATIVE_TASK" };
        const first = await invoke(request, "work__task__create", args);
        expect(first.status).toBe(200);
        const result = WorkCommandResult.parse((await first.json() as {result:unknown}).result);
        if(result.kind!=="task")throw new Error("Synthetic task expected");
        const repeated = await invoke(request, "work__task__create", args);
        expect(await repeated.json()).toEqual({result});
        expect((await f.client.workTasks()).length).toBe(1);
        expect((await invoke(request, "work__task__create", { title: "Different" })).status).toBe(409);
        expect((await invoke("synthetic-denied-write-1234", "work__task__complete", { task: result.task.id })).status).toBe(403);
        await f.client.nativeAction(s.id, { action: "interrupt" });
        expect((await pending).turn.status).toBe("unknown");
        await until(()=>f.client.nativeSession(s.id),s=>s.view.stopped===true);
        await expect(f.client.nativeAction(s.id, { action: "resolve", resolution: "verified-complete", note: "Synthetic operator review", processes_stopped: true })).resolves.toMatchObject({ quarantined: false });
        expect((await f.client.nativeSession(s.id)).view.state).toBe("closed");
        expect((await f.create()).view.state).toBe("ready");
    }
    finally {
        await f.close();
    }
}, 20000);
test("native recovery refuses missing local state and changed connection configuration", async () => {
    const f = await fixture();
    try {
        const s = await f.create();
        await f.manager.disconnect();
        await until(() => f.client.nativeSession(s.id), s => s.view.state === "offline");
        f.store.db.query("DELETE FROM sessions WHERE id=?").run(s.id);
        await f.client.nativeAction(s.id, { action: "resume" });
        const failed = await until(() => f.client.nativeSession(s.id), s => s.view.state === "failed");
        expect(failed.view.error).toBe("native.state_lost");
        expect(f.store.get(s.id)?.thread).toBeUndefined();
        await f.client.saveAIConnection({ name: "Changed name", kind: "codex-account", host: "synthetic-runtime" }, f.connection.id);
        await expect(f.client.nativeAction(s.id, { action: "resume" })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    finally {
        await f.close();
    }
}, 20000);

test("purging a closed native conversation clears Hub payloads and keeps late events harmless",async()=>{
 const f=await fixture();try{const s=await f.create();await f.client.assistantChat({request_id:"synthetic-purge-turn-1234",conversation:s.conversation,message:"SYNTHETIC_PURGE_CONTENT"});
 await f.client.deleteConversation(s.conversation,{request_id:"synthetic-delete-native-1234"});await until(()=>f.store.get(s.id),v=>v?.view.state==="closed");
 await f.client.purgeTrash(s.conversation,{request_id:"synthetic-purge-native-1234"});await expect(f.client.nativeSession(s.id)).rejects.toMatchObject({code:"NOT_FOUND"});
 expect(f.hub.modules.ai.store.events(s.id)).toEqual([]);expect(f.hub.modules.ai.store.deliveries(s.id)).toEqual([]);expect(f.hub.modules.ai.store.retired(s.id,s.runtime)).toBe(true);expect((await f.client.aiRuntimes())[0]?.online).toBe(true);
 }finally{await f.close();}
},20000);
