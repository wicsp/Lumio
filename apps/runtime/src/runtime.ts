import { SudoGate } from "./sudo.ts";
import { privateFile } from "./service.ts";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { RuntimeAck, RuntimeInfo, RuntimeRegistration, RuntimeSync } from "@lumio/schema";
import type { RuntimeConfig } from "./config.ts";
import { detectEngines } from "./engines.ts";
import { Queue } from "./queue.ts";
import { Executor } from "./executor.ts";
import { RoutinePlans } from "./routines.ts";
import { RuntimeArchives } from "./archive.ts";

class Wake {
  private listeners = new Set<() => void>();
  private pending = false;
  notify() { if (!this.listeners.size) this.pending = true; for (const listener of this.listeners) listener(); }
  async wait(ms: number, signal: AbortSignal) {
    if (signal.aborted) return;
    if (this.pending) { this.pending = false; return; }
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.listeners.delete(done); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      this.listeners.add(done); signal.addEventListener("abort", done, { once: true });
    });
  }
}
export async function runRuntime(config: RuntimeConfig, options: {
  signal: AbortSignal;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** 例行任务用的时钟（测试注入）。 */
  now?: () => Date;
}): Promise<void> {
  const shutdown = new AbortController();
  const signal = AbortSignal.any([options.signal, shutdown.signal]);
  const log = options.log ?? console.log;
  const fetcher = options.fetch ?? globalThis.fetch;
  const events = new Wake(), deliveries = new Wake(), archiveWake = new Wake();
  const wait = options.sleep ?? ((milliseconds, signal) => events.wait(milliseconds, signal));
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const registration = RuntimeRegistration.parse({ ...config.registration, engines: await detectEngines(options.env) });
  const queue = new Queue(config.stateDir);
  const plans = new RoutinePlans(queue);
  const archives = new RuntimeArchives(config, queue, fetcher, log);
  const now = options.now ?? (() => new Date());
  let actor: string | undefined;
  const sudo = new SudoGate(config, queue, () => actor, fetcher, signal, log);
  const executor = new Executor(queue, config, options.env ?? process.env, () => { events.notify(); deliveries.notify(); archiveWake.notify(); }, registration.engines, sudo);
  let registered = false, disconnected = false;
  let backoff = Math.min(config.pollSeconds, 60);
  async function send(path: string, body: unknown) {
    return fetcher(`${config.url}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
  }
  async function post<T>(path: string, body: unknown, schema: { parse(value: unknown): T }): Promise<T> {
    const response = await send(path, body);
    if (!response.ok) throw new Error("Hub 请求失败");
    return schema.parse(await response.json());
  }
  async function deliver() {
    const retries = new Map<string, { at: number; delay: number }>(), conflicts = new Set<string>();
    while (!signal.aborted) {
      await sudo.flush();
      let next = 60_000;
      for (const result of queue.outbox()) {
        if (signal.aborted) break;
        // Recovery results also wait for a successful ack before being delivered.
        if (conflicts.has(result.job) || !queue.jobs().find((j) => j.spec.id === result.job)?.acked) continue;
        const retry = retries.get(result.job);
        if (retry && retry.at > Date.now()) { next = Math.min(next, retry.at - Date.now()); continue; }
        try {
          const response = await send("/v1/runtime/results", result);
          if (response.status === 200) { queue.delivered(result.job); retries.delete(result.job); }
          else if (response.status === 409) { conflicts.add(result.job); log(`Job ${result.job} 结果交回冲突（409），已保留，等待人工处理`); }
          else throw new Error("Hub 请求失败");
        } catch {
          if (signal.aborted) break;
          const delay = Math.min(retry ? retry.delay * 2 : config.pollSeconds, 60);
          retries.set(result.job, { delay, at: Date.now() + delay * 1000 }); next = Math.min(next, delay * 1000);
        }
      }
      await deliveries.wait(Math.max(1, next), signal);
    }
  }
  let delivering: Promise<void> | undefined;
  let archiving: Promise<void> | undefined;
  let deliveryFailure: unknown;
  try {
    await sudo.start();
    await executor.recover();
    delivering = deliver().catch((cause) => { deliveryFailure = cause; shutdown.abort(); });
    archiving = (async () => { while (!signal.aborted) { const next = await archives.flush(signal); await archiveWake.wait(Math.max(1, next), signal); } })()
      .catch(() => { if (!signal.aborted) log("文件归档暂时中断，原始日志与待交付记录已保留"); });
    while (!signal.aborted) {
      let delay = config.pollSeconds;
      let justAcked = false;
      try {
        if (!registered) {
          const info = await post("/v1/runtime/register", registration, RuntimeInfo);
          actor = info.actor;
          await privateFile(join(config.stateDir, "registered.json"), JSON.stringify(info));
          registered = true;
          log("执行器登记成功");
          if (disconnected) log("Hub 连接已恢复");
          disconnected = false;
          archives.retryNow(); archiveWake.notify();
        } else {
          const sync = await post("/v1/runtime/sync", queue.heartbeat(), RuntimeSync);
          queue.receive(sync.jobs);
          const accepted = queue.jobs().filter((j) => !j.acked).map((j) => j.spec.id);
          if (accepted.length) {
            await post("/v1/runtime/ack", RuntimeAck.parse({ accepted }), RuntimeAck);
            queue.ack(accepted); deliveries.notify(); justAcked = true;
          }
          executor.cancel(sync.cancel);
          if (actor) plans.replace(sync.routines, actor, now());
        }
        backoff = Math.min(config.pollSeconds, 60);
      } catch {
        if (signal.aborted) break;
        if (!disconnected) log("Hub 连接失联，正在重试");
        disconnected = true; registered = false;
        delay = backoff; backoff = Math.min(backoff * 2, 60);
      }
      // 例行任务到点就生成 Job，不论 Hub 是否在线（ADR 0019 第 6 节）。
      if (plans.fire(now()).length) deliveries.notify();
      if (!justAcked) executor.pump();
      try { await wait(delay * 1000, signal); } catch (cause) { if (!signal.aborted) throw cause; }
    }
  } finally {
    shutdown.abort();
    await executor.shutdown();
    await sudo.close();
    await delivering;
    await archiving;
    queue.close();
  }
  if (deliveryFailure) throw deliveryFailure;
}
