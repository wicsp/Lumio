import { StringDecoder } from "node:string_decoder";
import { finished } from "node:stream/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RuntimeConfig } from "./config.ts";
import { Queue, type LocalJob } from "./queue.ts";

export function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; }
}
function signalGroup(pid: number, signal: NodeJS.Signals) { try { process.kill(-pid, signal); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; } }
export async function killGroup(pid: number) {
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (groupExists(pid) && Date.now() < deadline) await sleep(25);
  if (groupExists(pid)) signalGroup(pid, "SIGKILL");
}
/**
 * 被执行的程序（以及 P2-3 起的 agent）拿不到执行器自己的配置，尤其是 LUMIO_TOKEN（P2-2 review）。
 * 局限：执行器与被执行的程序是同一个系统账号，后者仍可能读到执行器的配置文件；真正隔离需要单独的账号（见待办）。
 */
export function jobEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("LUMIO_")));
}
export class Executor {
  private running = new Map<string, { child: ChildProcess; stop?: Promise<void>; reason?: "超时" | "取消" }>();
  private pending = new Set<Promise<void>>();
  private stopping = false;
  constructor(private queue: Queue, private config: RuntimeConfig, private env: NodeJS.ProcessEnv, private wake: () => void) {}
  async recover() {
    for (const job of this.queue.jobs().filter((j) => j.state === "running")) {
      if (job.pid && groupExists(job.pid)) await killGroup(job.pid);
      this.queue.finish({ job: job.spec.id, lease: job.spec.lease, status: "unknown", ...(job.started ? { started: job.started } : {}), finished: new Date().toISOString(), error: "执行器重启" });
    }
  }
  cancel(ids: string[]) {
    for (const id of ids) {
      const job = this.queue.jobs().find((j) => j.spec.id === id);
      if (job?.state === "queued") { this.queue.finish({ job: id, lease: job.spec.lease, status: "cancelled", finished: new Date().toISOString() }); this.wake(); }
      else this.stop(id, "取消");
    }
  }
  private stop(id: string, reason: "超时" | "取消") {
    const run = this.running.get(id);
    if (!run || run.stop) return;
    run.reason = reason;
    run.stop = run.child.pid ? killGroup(run.child.pid) : Promise.resolve();
  }
  pump() {
    if (this.stopping) return;
    for (const job of this.queue.jobs()) {
      if (this.running.size >= this.config.registration.max_concurrent) break;
      if (job.state !== "queued" || !job.acked) continue;
      // start() is synchronous, preventing the next pump from selecting the same job.
      this.queue.start(job.spec.id, new Date().toISOString());
      const pending = this.execute(job).finally(() => { this.pending.delete(pending); this.wake(); });
      this.pending.add(pending);
    }
  }
  private async execute(job: LocalJob) {
    const spec = job.spec, started = this.queue.jobs().find((j) => j.spec.id === spec.id)!.started!;
    const finish = (fields: Parameters<Queue["finish"]>[0]) => this.queue.finish(fields);
    if (spec.run.kind !== "command" || !this.config.allowedCommands.includes(spec.run.argv[0]!)) {
      finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), status: "failed", error: "程序不在 LUMIO_RUNTIME_ALLOWED_COMMANDS 允许列表中" }); return;
    }
    const logs = join(this.config.stateDir, "logs");
    // Synchronous reservation above is counted even while mkdir awaits.
    const placeholder: { child: ChildProcess; stop?: Promise<void>; reason?: "超时" | "取消" } = { child: {} as ChildProcess };
    this.running.set(spec.id, placeholder);
    let report = "";
    const log = join(logs, `${spec.id}.log`), completion = join(logs, `${spec.id}.exit.json`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await mkdir(logs, { recursive: true, mode: 0o700 });
      if (this.stopping) return;
      if (placeholder.reason) { finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), status: "cancelled" }); return; }
      const output = createWriteStream(log, { mode: 0o600 });
      let outputError = false;
      const written = finished(output).catch(() => { outputError = true; });
      const decoder = new StringDecoder("utf8");
      output.on("error", () => { outputError = true; this.stop(spec.id, "取消"); });
      const workerArgs = process.argv[1]?.endsWith(".ts") ? [process.argv[1], "--job-worker"] : ["--job-worker"];
      const child = spawn(process.execPath, workerArgs, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: this.env, shell: false });
      placeholder.child = child;
      const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
      child.stdin!.on("error", () => {});
      if (!child.pid) { await exited; throw new Error("spawn"); }
      this.queue.pid(spec.id, child.pid);
      const write = (chunk: Buffer) => {
        if (!output.write(chunk)) {
          child.stdout!.pause(); child.stderr!.pause();
          output.once("drain", () => { child.stdout!.resume(); child.stderr!.resume(); });
        }
      };
      child.stdout!.on("data", (chunk: Buffer) => { report = (report + decoder.write(chunk)).slice(-4000); write(chunk); });
      child.stderr!.on("data", write);
      const workdir = spec.workdir === "~" ? homedir() : spec.workdir.startsWith("~/") ? join(homedir(), spec.workdir.slice(2)) : spec.workdir;
      child.stdin!.end(JSON.stringify({ spec: { ...spec, workdir }, completion, env: { ...jobEnv(this.env), ...(spec.gpus ? { CUDA_VISIBLE_DEVICES: spec.gpus.join(",") } : {}) } }));
      const deadline = Date.now() + spec.timeout_seconds * 1000;
      const armTimeout = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) this.stop(spec.id, "超时");
        else timer = setTimeout(armTimeout, Math.min(remaining, 2_147_483_647));
      };
      armTimeout();
      await exited;
      await placeholder.stop;
      report = (report + decoder.end()).slice(-4000);
      output.end(); await written;
      if (this.stopping) return;
      let result: { exit_code?: number; signal?: string; error?: string } = {};
      try { result = JSON.parse(await readFile(completion, "utf8")); } catch { result.error = "程序未提供退出状态"; }
      await rm(completion, { force: true });
      finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), ...result, report, log,
        status: placeholder.reason === "取消" ? "cancelled" : !placeholder.reason && !outputError && result.exit_code === 0 ? "done" : "failed",
        ...(placeholder.reason === "超时" ? { error: "超时" } : outputError ? { error: "无法写入日志" } : {}) });
    } catch {
      if (!this.stopping) finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), status: "failed", error: "无法执行程序", report, log });
    } finally { if (timer) clearTimeout(timer); this.running.delete(spec.id); }
  }
  async shutdown() {
    this.stopping = true;
    await Promise.all([...this.running.values()].map(async (run) => { if (run.child.pid) await killGroup(run.child.pid); }));
    await Promise.all(this.pending);
  }
}
