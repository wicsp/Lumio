import { prepareProjectWorktree } from "./project-worktree.ts";
import { createHash } from "node:crypto";
import type { CodexJobCredential, ConnectionAuth } from "./native/connection-auth.ts";
import { splitPermissionRequest } from "./permission-request.ts";
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
import { JobActionReceipt, JobControlTarget, JobHumanRequest, type GitState, type RuntimeRegistration } from "@lumio/schema";
import { RunLogWriter, finalizeInterruptedLog } from "@lumio/storage/logs";
import { ADAPTERS, CODEX_GIT_MINIMUM_VERSION, PI_ACTIVITY_VERSION, compareVersions, splitQuestion, versionSupported, type Adapter } from "./agents.ts";
import type { RuntimeConfig } from "./config.ts";
import { Queue, type LocalJob } from "./queue.ts";
import type { RuntimeJobActivity } from "./job-activity.ts";
import { JobOutput } from "./job-output.ts";
import { interactiveEngine, interactiveWorkspace, type JobEngineConfig } from "./job-engine-config.ts";

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
type RunningJob = { child: ChildProcess; stop?: Promise<void>; reason?: "timeout" | "cancelled"; interactive?: boolean; forced?: boolean };
export class Executor {
  private running = new Map<string, RunningJob>();
  private pending = new Set<Promise<void>>();
  private stopping = false;
  private maxConcurrent: number;
  private worktrees = new Set<string>();
  private repositoryPreparation: Promise<unknown> = Promise.resolve();
  constructor(private queue: Queue, private config: RuntimeConfig, private env: NodeJS.ProcessEnv, private wake: () => void,
    private engines: Engines = [], private sudo?: SudoGate, private activity?: RuntimeJobActivity, private accounts?: ConnectionAuth) {
    this.maxConcurrent = config.registration.max_concurrent;
  }
  useHubAdmission(): void { this.maxConcurrent = Infinity; }
  setConcurrency(override: number | null): number {
    return this.maxConcurrent = override ?? this.config.registration.max_concurrent;
  }
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
    run.stop = (async () => {
      if (!run.child.pid) return;
      if (run.interactive && run.child.connected) {
        try { run.child.send({ kind: "stop" }); } catch { /* force independently */ }
        const deadline = Date.now() + 6000;
        while (run.child.exitCode === null && run.child.signalCode === null && Date.now() < deadline) await sleep(50);
        if (run.child.exitCode === 0 && !groupExists(run.child.pid)) return;
      }
      run.forced = !!run.interactive;
      await killGroup(run.child.pid);
    })();
  }
  pump() {
    if (this.stopping) return;
    for (const job of this.queue.jobs()) {
      if (this.pending.size >= this.maxConcurrent) break;
      if (job.state !== "queued" || !job.acked) continue;
      const workspace = job.spec.worktree?.task;
      if (workspace && this.worktrees.has(workspace)) continue;
      if (workspace) this.worktrees.add(workspace);
      // start() is synchronous, preventing the next pump from selecting the same job.
      this.queue.start(job.spec.id, new Date().toISOString());
      const slot: RunningJob = { child: {} as ChildProcess };
      this.running.set(job.spec.id, slot);
      const pending = this.execute(job, slot).finally(() => {
        this.running.delete(job.spec.id);
        this.pending.delete(pending);
        if (workspace) this.worktrees.delete(workspace);
        this.wake();
      });
      this.pending.add(pending);
    }
  }
  private async execute(job: LocalJob, placeholder: RunningJob) {
    const access = this.queue.access(job.spec.id);
    const account = this.queue.account(job.spec.id);
    const secrets = [this.config.token, this.env.LUMIO_TOKEN ?? "", access?.token ?? ""].filter(Boolean);
    const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
    const roundDirectory = join(this.config.stateDir, "agent-config", job.spec.id);
    const spec = job.spec, started = this.queue.jobs().find((j) => j.spec.id === spec.id)!.started!;
    let trace: RunLogWriter | undefined;
    let managedWorkspace: import("@lumio/schema").JobResult["workspace"];
    const activity = this.activity;
    activity?.record(spec.id, { type: "phase", phase: "preparing" });
    const finish = async (fields: Parameters<Queue["finish"]>[0]) => {
      try { if (trace) { await trace.append("status", { status: fields.status }); await trace.close(); } }
      catch { fields = { ...fields, status: fields.status === "cancelled" || fields.status === "unknown" ? fields.status : "failed", error: msg("executor.could_not_seal_run_log") }; }
      if (fields.status === "failed") activity?.record(spec.id, { type: "error", category: "engine" });
      activity?.record(spec.id, { type: "phase", phase: "finishing" });
      const unavailable = this.sudo?.unavailableFor(spec.id);
      this.queue.finish({ ...fields, ...(managedWorkspace ? { workspace: managedWorkspace } : {}), ...(unavailable ? { privileged_unavailable: { program: redact(unavailable) } } : {}),
        ...(fields.report === undefined ? {} : { report: redact(fields.report) }),
        ...(fields.question === undefined ? {} : { question: redact(fields.question) }),
        ...(fields.error === undefined ? {} : { error: redact(fields.error) }) });
    };
    const fail = (error: string) => finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), status: "failed", error });
    let workdir = spec.workdir === "~" ? homedir() : spec.workdir.startsWith("~/") ? join(homedir(), spec.workdir.slice(2)) : spec.workdir;
    const run = spec.run;
    let argv: string[];
    const injected = stageSecrets(run.kind === "agent" ? run.permissions : undefined, this.env);
    if (!injected) { await fail(msg("executor.stage_secret_unavailable")); return; }
    secrets.push(...Object.values(injected).filter((value): value is string => !!value));
    secrets.sort((a, b) => b.length - a.length);
    let gitPaths: string[] | undefined;
    let interactive: JobEngineConfig | undefined;
    let structuredProgress = false;
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
        await fail(msg("executor.engine_version_too_old", run.engine, detected.version, adapter.minimumVersion)); return;
      }
      if (run.interaction && activity?.supported()) interactive = await interactiveEngine(run.engine, detected.version, this.env, Boolean(account));
      if (run.interaction && (!interactive || run.permissions?.access === "full")) { await fail(msg("executor.interactive_unavailable")); return; }
      if (spec.worktree) {
        if (interactive && !await interactiveWorkspace(workdir, this.config.stateDir, interactive, [], Boolean(account))) {
          await fail(msg("executor.interactive_workdir")); return;
        }
        // Serialize Git registry mutations while other jobs may already be executing.
        const preparation = this.repositoryPreparation.then(() => prepareProjectWorktree(this.config.stateDir, workdir, spec.worktree!, this.env));
        this.repositoryPreparation = preparation.catch(() => {});
        try { managedWorkspace = await preparation; workdir = managedWorkspace.path; }
        catch { await fail(msg("executor.project_worktree_unavailable")); return; }
        if (interactive?.roots.length) interactive = { ...interactive, roots: [workdir] };
      }
      if (run.engine === "codex" && run.permissions?.git && run.permissions.access !== "full") {
        if (!interactive && compareVersions(detected.version, CODEX_GIT_MINIMUM_VERSION) < 0) {
          await fail(msg("executor.git_profile_version", CODEX_GIT_MINIMUM_VERSION)); return;
        }
        gitPaths = gitWritePaths(workdir, this.env);
        if (!gitPaths.length) { await fail(msg("executor.git_profile_workdir")); return; }
      }
      if (interactive) {
        if (run.engine !== "codex" && run.permissions?.git) {
          gitPaths = gitWritePaths(workdir, this.env);
          if (!gitPaths.length) { await fail(msg("executor.git_profile_workdir")); return; }
        }
        const workspace = await interactiveWorkspace(workdir, this.config.stateDir, interactive, gitPaths ?? [], Boolean(account));
        if (!workspace) { await fail(msg("executor.interactive_workdir")); return; }
        workdir = workspace.cwd;
        gitPaths = workspace.gitPaths;
        if (account) {
          if (!this.accounts || !await activity?.authorized(spec)) { await fail(msg("executor.account_unavailable")); return; }
          try { await this.accounts.access(account.connection, account.owner, account, undefined, true); }
          catch { await fail(msg("executor.account_unavailable")); return; }
        } else if (interactive.key) secrets.push(interactive.key);
        secrets.sort((a, b) => b.length - a.length);
      }
      structuredProgress = run.engine === "pi" && detected.version === PI_ACTIVITY_VERSION;
      const lastMessageFile = join(roundDirectory, "last.txt");
      agent = { adapter, version: detected.version, lastMessageFile, before: gitState(workdir, this.env) };
      argv = [executable, ...adapter.argv(run, { lastMessageFile, gitPaths, structuredProgress })];
    }
    const logs = join(this.config.stateDir, "logs");
    placeholder.interactive = Boolean(interactive);
    const parser = run.kind === "agent" ? new JobOutput(run.engine, workdir, event => activity?.record(spec.id, event), redact) : undefined;
    let report = "", stdoutAll = "";
    const log = join(logs, `${spec.id}.log`), completion = join(logs, `${spec.id}.exit.json`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await mkdir(logs, { recursive: true, mode: 0o700 });
      if (agent) await mkdir(roundDirectory, { recursive: true, mode: 0o700 });
      if (agent && access && Date.parse(access.expires) > Date.now()) {
        const skillFile = await installSkill(join(roundDirectory, "skills", "lumio"));
        argv = [argv[0]!, ...agent.adapter.argv(spec.run as Extract<typeof spec.run, { kind: "agent" }>, { lastMessageFile: agent.lastMessageFile, skillFile, skillText: SKILL_TEXT, gitPaths, structuredProgress })];
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
      const child = spawn(process.execPath, workerArgs, { detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env: childEnv, shell: false });
      placeholder.child = child;
      activity?.begin(spec.id);
      const awaiting = new Map<string, (state: JobActionReceipt["state"]) => void>();
      let openPrompt: JobHumanRequest | null = null;
      const cancel = () => this.stop(spec.id, "cancelled");
      if (account) activity?.control(spec.id, { target: null, pending: null, cancel, apply: async () => "rejected" });
      let credentialRequest = false;
      child.on("message", value => {
        if (!value || typeof value !== "object") return;
        if ("phase" in value && (value.phase === "before_hook" || value.phase === "engine" || value.phase === "after_hook")) {
          activity?.record(spec.id, { type: "phase", phase: value.phase });
          return;
        }
        if (!interactive || !activity || !("kind" in value)) return;
        if (value.kind === "job-credential" && account && "id" in value && typeof value.id === "string") {
          if (credentialRequest) return;
          const id = value.id, rejected = "rejected" in value && typeof value.rejected === "string" && /^[a-f0-9]{64}$/.test(value.rejected) ? value.rejected : undefined;
          credentialRequest = true;
          void (async () => {
            let material: CodexJobCredential | undefined;
            try {
              if (!placeholder.reason && await activity.authorized(spec)) {
                material = await this.accounts?.access(account.connection, account.owner, account, rejected, true);
              }
              if (material) {
                secrets.push(material.accessToken);
                for (const secret of [material.accessToken, JSON.stringify(material.accessToken).slice(1, -1)]) {
                  stdoutRedactor.add(secret); stderrRedactor.add(secret);
                }
              }
            } catch { material = undefined; }
            finally { credentialRequest = false; }
            if (child.connected && !placeholder.reason) child.send({ kind: "job-credential", id, material }, () => {});
          })().catch(() => {});
          return;
        }
        if (value.kind === "action-result" && "request_id" in value && "state" in value) {
          const result = JobActionReceipt.safeParse({ request_id: value.request_id, state: value.state, at: new Date().toISOString() });
          if (result.success) awaiting.get(result.data.request_id)?.(result.data.state);
        }
        if (value.kind !== "control" || !("target" in value) || !("pending" in value)) return;
        const target = JobControlTarget.nullable().safeParse(value.target), pending = JobHumanRequest.nullable().safeParse(value.pending);
        if (!target.success || !pending.success) return;
        if (pending.data && pending.data.id !== openPrompt?.id) activity.record(spec.id, { type: "request_opened", prompt_id: pending.data.id });
        if (!pending.data && openPrompt) {
          const closed = "closed" in value && value.closed && typeof value.closed === "object"
            && "outcome" in value.closed ? value.closed.outcome : "unknown";
          if (closed === "answered" || closed === "approved" || closed === "denied" || closed === "expired" || closed === "cancelled" || closed === "unknown") {
            activity.record(spec.id, { type: "request_closed", prompt_id: openPrompt.id, outcome: closed });
          }
        }
        openPrompt = pending.data;
        activity.control(spec.id, {
          target: target.data, pending: pending.data,
          cancel,
          apply: action => new Promise(resolve => {
            const finish = (state: JobActionReceipt["state"]) => { clearTimeout(timer); awaiting.delete(action.request_id); resolve(state); };
            const timer = setTimeout(() => finish("unknown"), 5000);
            awaiting.set(action.request_id, finish);
            if (!child.connected || placeholder.reason) { finish("rejected"); return; }
            try { child.send({ kind: "action", action }, error => { if (error) finish("unknown"); }); } catch { finish("unknown"); }
          }),
        });
      });
      child.once("close", () => { for (const resolve of awaiting.values()) resolve("unknown"); });
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
      child.stdout!.on("data", (chunk: Buffer) => {
        parser?.push(chunk);
        stdout(stdoutRedactor.push(chunk));
      });
      child.stderr!.on("data", (chunk: Buffer) => { const clean = stderrRedactor.push(chunk); if (clean.length) write(clean, "stderr"); });
      child.stdin!.end(JSON.stringify({ spec: { ...spec, workdir }, argv, completion, hookEnv: childEnv,
        lastMessageFile: agent?.lastMessageFile, hookReportFile: agent ? join(roundDirectory, "hook-report.txt") : undefined,
        ...(interactive ? { interactive: { provider: interactive, stateDir: this.config.stateDir, gitPaths: gitPaths ?? [], instructions: access ? SKILL_TEXT : undefined,
          ...(account ? { accountKey: createHash("sha256").update(JSON.stringify([account.connection, account.owner, account.account, account.generation])).digest("hex") } : {}),
        } } : {}),
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
      parser?.push(Buffer.alloc(0), true);
      const stderrTail = stderrRedactor.push(Buffer.alloc(0), true); if (stderrTail.length) write(stderrTail, "stderr");
      const tail = decoder.end();
      report = (report + tail).slice(-4000);
      if (agent && stdoutAll.length < MAX_AGENT_STDOUT) stdoutAll += tail;
      output.end(); await written;
      if (this.stopping) return;
      let result: { unknown?: boolean; interrupted?: boolean; exit_code?: number; signal?: string; error?: string } = {};
      try { result = JSON.parse(await readFile(completion, "utf8")); } catch { result.error = msg("executor.program_did_not_provide_exit_status"); }
      await rm(completion, { force: true });
      const ok = !placeholder.reason && !result.unknown && !outputError && result.exit_code === 0;
      const stopped = result.unknown || placeholder.forced ? "unknown" : placeholder.reason === "cancelled" ? "cancelled" : undefined;
      const { unknown: _unconfirmed, interrupted: _interrupted, ...exit } = result;
      const problem = placeholder.reason === "timeout" ? { error: "timeout" } : outputError ? { error: msg("executor.could_not_write_log") } : {};
      if (!agent) {
        await finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), ...exit, report, log,
          status: stopped ?? (ok ? "done" : "failed"), ...problem });
        return;
      }
      let lastMessage: string | undefined;
      try { lastMessage = await readFile(agent.lastMessageFile, "utf8"); } catch { /* 只有 codex 写这个文件 */ }
      await rm(agent.lastMessageFile, { force: true });
      const parsed = agent.adapter.parse(stdoutAll, lastMessage === undefined ? undefined : redact(lastMessage), run as Extract<typeof run, { kind: "agent" }>);
      const finalReport = parser?.report === undefined ? parsed.report ?? report : redact(parser.report);
      const sessionId = parser?.sessionId ?? parsed.sessionId;
      const requested = ok && spec.source?.task ? splitPermissionRequest(finalReport) : { report: finalReport, permission: undefined };
      const split = splitQuestion(requested.report);
      const after = gitState(workdir, this.env);
      await finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), ...exit, log,
        report: split.report.slice(0, MAX_REPORT),
        ...(split.question && ok ? { question: split.question } : {}),
        ...(requested.permission ? { permission: requested.permission } : {}),
        status: stopped ?? (ok ? (split.question || requested.permission ? "waiting_for_human" : "done") : "failed"),
        engine: { name: agent.adapter.engine, version: agent.version, sandbox: interactive ? "os" : run.kind === "agent" && run.permissions?.access === "full" ? "none" : agent.adapter.sandbox },
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(agent.before || after ? { git: { ...(agent.before ? { before: agent.before } : {}), ...(after ? { after } : {}) } } : {}),
        ...problem });
    } catch {
      if (!this.stopping) await finish({ job: spec.id, lease: spec.lease, started, finished: new Date().toISOString(), status: "failed", error: msg("executor.could_not_execute_program"), report, log });
    } finally { activity?.end(spec.id); await rm(roundDirectory, { recursive: true, force: true }); await trace?.close().catch(() => {}); this.sudo?.end(spec.id); if (timer) clearTimeout(timer); this.running.delete(spec.id); }
  }
  async shutdown() {
    this.stopping = true;
    for (const id of this.running.keys()) this.sudo?.end(id);
    await Promise.all([...this.running.values()].map(async (run) => { if (run.child.pid) await killGroup(run.child.pid); }));
    await Promise.all(this.pending);
  }
}
