import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { NativeRuntimeCommand, NativeRuntimeMessage } from "@lumio/schema";
import type { RuntimeConfig } from "../config.ts";
import { NativeLocalStore } from "./store.ts";
import { NativeManager } from "./manager.ts";
import { ConnectionAuth } from "./connection-auth.ts";
/** Two authenticated HTTP legs; durable events and commands retain independent semantics. */
export async function runNativeChannel(
  config: RuntimeConfig,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const store = new NativeLocalStore(config.stateDir);
  let channel: string | undefined;
  let flushing = false,
    pendingFlush = false;
  let controller: AbortController | undefined;
  const post = async (value: unknown) => {
    const r = await fetch(`${config.url}/v2/runtime/native/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "X-Lumio-Native-Channel": channel ?? "",
      },
      body: JSON.stringify(value),
      redirect: "error",
      signal: AbortSignal.any([signal, controller!.signal, AbortSignal.timeout(10000)]),
    });
    if (!r.ok) throw new Error("Native channel unavailable");
  };
  const flush = () => {
    pendingFlush = true;
    if (flushing || !channel || signal.aborted) return;
    flushing = true;
    void (async () => {
      try {
        do {
          pendingFlush = false;
          for (const m of store.events()) {
            if (!channel || signal.aborted) break;
            await post(m);
          }
        } while (pendingFlush && channel && !signal.aborted);
      } catch {
        controller?.abort();
      } finally {
        flushing = false;
      }
    })();
  };
  const accounts = new ConnectionAuth(config.stateDir, { codex: env.LUMIO_NATIVE_CODEX });
  const manager = new NativeManager(store, config.stateDir, flush, {
    runtimeName: config.registration.name,
    codex: env.LUMIO_NATIVE_CODEX,
  }, accounts);
  await manager.recover();
  try {
    while (!signal.aborted) {
      controller = new AbortController();
      const current = controller;
      try {
        const response = await fetch(`${config.url}/v2/runtime/native`, {
          headers: { Authorization: `Bearer ${config.token}` },
          redirect: "error",
          signal: AbortSignal.any([signal, current.signal]),
        });
        if (!response.ok || !response.body) throw new Error("Native channel unavailable");
        channel = response.headers.get("x-lumio-native-channel") ?? undefined;
        if (!channel) throw new Error("Native handshake unavailable");
        const connectionAuth = response.headers.get("x-lumio-native-connection-auth") === "1";
        const connectionUsage = response.headers.get("x-lumio-native-connection-usage") === "1" && connectionAuth;
        await post(
          NativeRuntimeMessage.parse({
            type: "hello",
            protocol: 1,
            instance: randomUUID(),
            version: "1",
            isolation: process.platform === "darwin" ? "macos-seatbelt" : "unsupported",
            ...(connectionAuth ? { connection_auth: true } : {}),
            ...(connectionUsage ? { connection_usage: true } : {}),
          }),
        );
        flush();
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 2 * 1024 * 1024) throw new Error("Native frame too large");
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              if (!line.trim()) continue;
              const c = NativeRuntimeCommand.parse(JSON.parse(line));
              if (c.type === "connection_usage") {
                if (!connectionUsage) throw new Error("Connection usage was not negotiated");
                void accounts.usage(c.connection, c.owner).then(result => {
                  if (current.signal.aborted || signal.aborted || controller !== current) return;
                  return post(NativeRuntimeMessage.parse({ type: "connection_usage", command: c.command, connection: c.connection, result }));
                }).catch(() => current.abort());
                continue;
              }
              if (c.type === "connection_auth") {
                if (!connectionAuth) throw new Error("Connection auth was not negotiated");
                void accounts.request(c).then(view => {
                  if (current.signal.aborted || signal.aborted || controller !== current) return;
                  return post(NativeRuntimeMessage.parse({ type: "connection_auth", command: c.command, connection: c.connection, owner: c.owner, view }));
                }).catch(() => current.abort());
                continue;
              }
              await manager.receive(c);
              flush();
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        /* The durable outbox remains for the next authenticated channel. */
      } finally {
        channel = undefined;
        current.abort();
        await manager.disconnect();
      }
      if (!signal.aborted)
        await new Promise<void>((r) => {
          const done = () => {
            clearTimeout(t);
            signal.removeEventListener("abort", done);
            r();
          };
          const t = setTimeout(done, 1500);
          signal.addEventListener("abort", done, { once: true });
        });
    }
  } finally {
    controller?.abort();
    await manager.stop();
    await accounts.stop();
    store.close();
  }
}
