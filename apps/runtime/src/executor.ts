import { gitWritePaths, stageSecrets } from "./stage.ts";
import { CredentialRedactor } from "./redact.ts";
import { installSkill, SKILL_TEXT } from "../../../skills/lumio/install.ts";
import { text as msg } from "./messages.ts";
import type { SudoGate } from "./sudo.ts";
import { StringDecoder } from "node:string_decoder";
import { finished } from "node:stream/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { GitState, RuntimeRegistration } from "@lumio/schema";
import { RunLogWriter, finalizeInterruptedLog } from "@lumio/storage/logs";
import { ADAPTERS, splitQuestion, versionSupported, type Adapter } from "./agents.ts";
import type { RuntimeConfig } from "./config.ts";
import { Queue, type LocalJob } from "./queue.ts";

type Engines = RuntimeRegistration["engines"];
/** agent 的 stdout 最多保留这么多字节用于解析（完整输出照旧写入日志）。 */
const MAX_AGENT_STDOUT = 4 * 1024 * 1024;
/** 交回的汇报最多这么多字符；完整内容在日志里。 */
const MAX_REPORT = 100_000;

/** workdir 是 git 仓库时记录分支、提交与是否有未提交的改动（P2-3）；不是仓库或 git 不可用时返回 undefined。 */
export function gitState(workdir: string, env: NodeJS.ProcessEnv): GitState | undefined {
  const run = (...args: string[]) => {
    const git = Bun.which("git", { PATH: env.PATH ?? "" });
    if (!git) return undefined;
    const result = Bun.spawnSync([git, "-C", workdir, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  };
  const commit = run("rev-parse", "HEAD");
  if (!commit || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return undefined;
  const branch = run("rev-parse", "--abbrev-ref", "HEAD");
  const status = run("status", "--porcelain");
  return { ...(branch && branch !== "HEAD" ? { branch } : {}), commit, dirty: Boolean(status) };
}

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
export function jobEnv(env: NodeJS.ProcessEnv, lumioExecutable?: string): NodeJS.ProcessEnv {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("LUMIO_")));
  if (lumioExecutable) childEnv.PATH = [dirname(lumioExecutable), env.PATH].filter(Boolean).join(delimiter);
  return childEnv;
}
export class Executor {
  private running = new Map<string, { child: ChildProcess; stop?: Promise<void>; reason?: "timeout" | "cancelled" }>();
  private pending = new Set<Promise<void>>();
  private stopping = false;
  constructor(private queue: Queue, private config: RuntimeConfig, private env: NodeJS.ProcessEnv, private wake: () => void,
    private engines: Engines = [], private sudo?: SudoGate) {}
  async recover() {
    for (const job of this.queue.jobs().filter((j) => j.state === "running")) {
      if (job.pid && groupExists(job.pid)) await killGroup(job.pid);
      await finalizeInterruptedLog(join(this.config.stateDir, "events"), job.spec.id);
      const log = join(this.config.stateDir, "logs", `${job.spec.id}.log`);
      this.queue.finish({ job: job.spec.id, lease: job.spec.lease, status: "unknown", ...(job.started ? { started: job.started } : {}),
        ...(await Bun.file(log).exists() ? { log } : {}), finished: new Date().toISOString(), error: "restarted" });
    }
  }
  cancel(ids: string[]) {
    for (const id of ids) {
      const job = this.queue.jobs().find((j) => j.spec.id === id);
      if (job?.state === "queued") { this.queue.finish({ job: id, lease: job.spec.lease, status: "cancelled", finished: new Date().toISOString() }); this.wake(); }
      else this.stop(id, "cancelled");
    }
  }
  private stop(id: string, reason: "timeout" | "cancelled") {
    const run = this.running.get(id);
    if (!run || run.stop) return;
    this.sudo?.end(id);
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
    const access = this.queue.access(job.spec.id);
    const secrets = [this.config.token, this.env.LUMIO_TOKEN ?? "", access?.token ?? ""].filter(Boolean);
    const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
    const roundDirectory = join(this.config.stateDir, "agent-config", job.spec.id);
    const spec = job.spec, started = this.queue.jobs().find((j) => j.spec.id === spec.id)!.started!;
    let trace: RunLogWriter | undefined;
    const finish = async (fields: Parameters<Queue["finish"]>[0]) => {
      try { if (trace) { await trace.append("status", { status: fields.status }); await trace.close(); } }
      catch { fields = { ...fields, status: fields.status === "cancelled" || fields.status === "unknown" ? fields.status : "failed", error: msg("executor.could_not_seal_run_log") }; }
      this.queue.finish({ ...fields, ...(fields.report === undefined ? {} : { report: redact(fields.report) }),
        ...(fields.question === undefined ? {} : { question: redact(fields.question) }),
        ...(fields.error === undefined ? {} : { error: redact(fields.error) }) });
    };
    const fail = (error: string) => finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), status: "failed", error });
    const workdir = spec.workdir === "~" ? homedir() : spec.workdir.startsWith("~/") ? join(homedir(), spec.workdir.slice(2)) : spec.workdir;
    const run = spec.run;
    let argv: string[];
    const injected = stageSecrets(run.kind === "agent" ? run.permissions : undefined, this.env);
    if (!injected) { await fail(msg("executor.stage_secret_unavailable")); return; }
    secrets.push(...Object.values(injected).filter((value): value is string => !!value));
    secrets.sort((a, b) => b.length - a.length);
    let gitPaths: string[] | undefined;
    let agent: { adapter: Adapter; version: string; lastMessageFile: string; before?: GitState } | undefined;
    if (run.kind === "command") {
      if (!this.config.allowedCommands.includes(run.argv[0]!)) { await fail(msg("executor.program_is_not_in_lumio_runtime_allowed_commands")); return; }
      argv = run.argv;
    } else {
      const adapter: Adapter = ADAPTERS[run.engine]!;
      const detected = this.engines.find((e) => e.name === run.engine);
      const executable = Bun.which(adapter.command, { PATH: this.env.PATH ?? "" });
      if (!detected || !executable) { await fail(msg("executor.is_not_installed_on_runtime", run.engine)); return; }
      if (!versionSupported(adapter, detected.version)) {
        await fail(msg("executor.is_outside_verified_version_range_verify_the_new_version_before_exte", run.engine, detected.version, adapter.versions.min, adapter.versions.below)); return;
      }
      if (run.engine === "codex" && run.permissions?.git && run.permissions.access !== "full") {
        if (detected.version !== "0.166.0") { await fail(msg("executor.git_profile_version")); return; }
        gitPaths = gitWritePaths(workdir, this.env);
        if (!gitPaths.length) { await fail(msg("executor.git_profile_workdir")); return; }
      }
      const lastMessageFile = join(roundDirectory, "last.txt");
      agent = { adapter, version: detected.version, lastMessageFile, before: gitState(workdir, this.env) };
      argv = [executable, ...adapter.argv(run, { lastMessageFile, gitPaths })];
    }
    const logs = join(this.config.stateDir, "logs");
    // Synchronous reservation above is counted even while mkdir awaits.
    const placeholder: { child: ChildProcess; stop?: Promise<void>; reason?: "timeout" | "cancelled" } = { child: {} as ChildProcess };
    this.running.set(spec.id, placeholder);
    let report = "", stdoutAll = "";
    const log = join(logs, `${spec.id}.log`), completion = join(logs, `${spec.id}.exit.json`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await mkdir(logs, { recursive: true, mode: 0o700 });
      if (agent) await mkdir(roundDirectory, { recursive: true, mode: 0o700 });
      if (agent && access && Date.parse(access.expires) > Date.now()) {
        const skillFile = await installSkill(join(roundDirectory, "skills", "lumio"));
        argv = [argv[0]!, ...agent.adapter.argv(spec.run as Extract<typeof spec.run, { kind: "agent" }>, { lastMessageFile: agent.lastMessageFile, skillFile, skillText: SKILL_TEXT, gitPaths })];
      }
      if (this.stopping) return;
      if (placeholder.reason) { await finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), status: "cancelled" }); return; }
      trace = await RunLogWriter.create(join(this.config.stateDir, "events"), spec.id);
      await trace.append("status", { status: "running", engine: run.kind === "agent" ? run.engine : "command" });
      if (this.stopping) return;
      if (placeholder.reason) { await finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), status: "cancelled" }); return; }
      const output = createWriteStream(log, { mode: 0o600 });
      let outputError = false;
      const written = finished(output).catch(() => { outputError = true; });
      const decoder = new StringDecoder("utf8");
      output.on("error", () => { outputError = true; this.stop(spec.id, "cancelled"); });
      const workerArgs = process.argv[1]?.endsWith(".ts") ? [process.argv[1], "--job-worker"] : ["--job-worker"];
      // Agent CLI calls use the binary installed beside the compiled Runtime.
      const childEnv = jobEnv(this.env, agent && workerArgs.length === 1 ? process.execPath : undefined);
      const child = spawn(process.execPath, workerArgs, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: childEnv, shell: false });
      placeholder.child = child;
      const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
      child.stdin!.on("error", () => {});
      if (!child.pid) { await exited; throw new Error("spawn"); }
      this.queue.pid(spec.id, child.pid);
      let rawReady = true, tracing = 0;
      const resume = () => { if (rawReady && tracing === 0) { child.stdout!.resume(); child.stderr!.resume(); } };
      const write = (chunk: Buffer, stream: "stdout" | "stderr") => {
        if (!output.write(chunk)) {
          rawReady = false;
          output.once("drain", () => { rawReady = true; resume(); });
        }
        tracing++; child.stdout!.pause(); child.stderr!.pause();
        void trace!.append("output", { stream, encoding: "base64", data: chunk.toString("base64") })
          .catch(() => { outputError = true; this.stop(spec.id, "cancelled"); })
          .finally(() => { tracing--; resume(); });
      };
      const encodedSecrets = secrets.flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]);
      const stdoutRedactor = new CredentialRedactor(encodedSecrets), stderrRedactor = new CredentialRedactor(encodedSecrets);
      const stdout = (chunk: Buffer) => {
        const text = decoder.write(chunk);
        report = (report + text).slice(-4000);
        if (agent && stdoutAll.length < MAX_AGENT_STDOUT) stdoutAll += text;
        if (chunk.length) write(chunk, "stdout");
      };
      child.stdout!.on("data", (chunk: Buffer) => stdout(stdoutRedactor.push(chunk)));
      child.stderr!.on("data", (chunk: Buffer) => { const clean = stderrRedactor.push(chunk); if (clean.length) write(clean, "stderr"); });
      child.stdin!.end(JSON.stringify({ spec: { ...spec, workdir }, argv, completion, hookEnv: childEnv,
        lastMessageFile: agent?.lastMessageFile, hookReportFile: agent ? join(roundDirectory, "hook-report.txt") : undefined,
        redactions: secrets, env: { ...childEnv, ...injected, ...this.sudo?.begin(spec),
        ...(run.kind === "agent" && access && Date.parse(access.expires) > Date.now() ? { LUMIO_HUB_URL: this.config.url, LUMIO_TOKEN: access.token } : {}), ...(spec.gpus ? { CUDA_VISIBLE_DEVICES: spec.gpus.join(",") } : {}) } }));
      const deadline = Date.now() + spec.timeout_seconds * 1000;
      const armTimeout = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) this.stop(spec.id, "timeout");
        else timer = setTimeout(armTimeout, Math.min(remaining, 2_147_483_647));
      };
      armTimeout();
      await exited;
      await placeholder.stop;
      stdout(stdoutRedactor.push(Buffer.alloc(0), true));
      const stderrTail = stderrRedactor.push(Buffer.alloc(0), true); if (stderrTail.length) write(stderrTail, "stderr");
      const tail = decoder.end();
      report = (report + tail).slice(-4000);
      if (agent && stdoutAll.length < MAX_AGENT_STDOUT) stdoutAll += tail;
      output.end(); await written;
      if (this.stopping) return;
      let result: { exit_code?: number; signal?: string; error?: string } = {};
      try { result = JSON.parse(await readFile(completion, "utf8")); } catch { result.error = msg("executor.program_did_not_provide_exit_status"); }
      await rm(completion, { force: true });
      const ok = !placeholder.reason && !outputError && result.exit_code === 0;
      const stopped = placeholder.reason === "cancelled" ? "cancelled" : undefined;
      const problem = placeholder.reason === "timeout" ? { error: "timeout" } : outputError ? { error: msg("executor.could_not_write_log") } : {};
      if (!agent) {
        await finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), ...result, report, log,
          status: stopped ?? (ok ? "done" : "failed"), ...problem });
        return;
      }
      let lastMessage: string | undefined;
      try { lastMessage = await readFile(agent.lastMessageFile, "utf8"); } catch { /* 只有 codex 写这个文件 */ }
      await rm(agent.lastMessageFile, { force: true });
      const parsed = agent.adapter.parse(stdoutAll, lastMessage === undefined ? undefined : redact(lastMessage), run as Extract<typeof run, { kind: "agent" }>);
      const split = splitQuestion(parsed.report ?? report);
      const after = gitState(workdir, this.env);
      await finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), ...result, log,
        report: split.report.slice(0, MAX_REPORT),
        ...(split.question && ok ? { question: split.question } : {}),
        status: stopped ?? (ok ? (split.question ? "waiting_for_human" : "done") : "failed"),
        engine: { name: agent.adapter.engine, version: agent.version, sandbox: run.kind === "agent" && run.permissions?.access === "full" ? "none" : agent.adapter.sandbox },
        ...(parsed.sessionId ? { session_id: parsed.sessionId } : {}),
        ...(agent.before || after ? { git: { ...(agent.before ? { before: agent.before } : {}), ...(after ? { after } : {}) } } : {}),
        ...problem });
    } catch {
      if (!this.stopping) await finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), status: "failed", error: msg("executor.could_not_execute_program"), report, log });
    } finally { await rm(roundDirectory, { recursive: true, force: true }); await trace?.close().catch(() => {}); this.sudo?.end(spec.id); if (timer) clearTimeout(timer); this.running.delete(spec.id); }
  }
  async shutdown() {
    this.stopping = true;
    for (const id of this.running.keys()) this.sudo?.end(id);
    await Promise.all([...this.running.values()].map(async (run) => { if (run.child.pid) await killGroup(run.child.pid); }));
    await Promise.all(this.pending);
  }
}
