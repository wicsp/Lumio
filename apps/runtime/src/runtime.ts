import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { RuntimeHeartbeat, RuntimeInfo, RuntimeRegistration, RuntimeSync } from "@lumio/schema";
import type { RuntimeConfig } from "./config.ts";
import { detectEngines } from "./engines.ts";

export async function runRuntime(config: RuntimeConfig, options: {
  signal: AbortSignal;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const { signal } = options;
  const log = options.log ?? console.log;
  const fetcher = options.fetch ?? globalThis.fetch;
  const wait = options.sleep ?? ((milliseconds, signal) => sleep(milliseconds, undefined, { signal }));
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const registration = RuntimeRegistration.parse({ ...config.registration, engines: await detectEngines(options.env) });
  let registered = false, disconnected = false;
  let backoff = Math.min(config.pollSeconds, 60);
  async function post<T>(path: string, body: unknown, schema: { parse(value: unknown): T }): Promise<T> {
    const response = await fetcher(`${config.url}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error("Hub 请求失败");
    return schema.parse(await response.json());
  }
  while (!signal.aborted) {
    let delay = config.pollSeconds;
    try {
      if (!registered) {
        await post("/v1/runtime/register", registration, RuntimeInfo);
        registered = true;
        log("执行器登记成功");
        if (disconnected) log("Hub 连接已恢复");
        disconnected = false;
      } else {
        await post("/v1/runtime/sync", RuntimeHeartbeat.parse({ running: [], queued: [], outbox: 0 }), RuntimeSync);
      }
      backoff = Math.min(config.pollSeconds, 60);
    } catch {
      if (signal.aborted) break;
      if (!disconnected) log("Hub 连接失联，正在重试");
      disconnected = true;
      registered = false;
      delay = backoff;
      backoff = Math.min(backoff * 2, 60);
    }
    try { await wait(delay * 1000, signal); } catch (cause) { if (!signal.aborted) throw cause; }
  }
}
