import { text as msg } from "./messages.ts";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { JobSpec, DEFAULT_HOOK_TIMEOUT_MINUTES, type PlanHook } from "@lumio/schema";
import { ADAPTERS } from "./agents.ts";
import { stageId } from "./stage.ts";
import { JobOutput } from "./job-output.ts";
import { runInteractive } from "./job-interactive.ts";
import type { JobEngineConfig } from "./job-engine-config.ts";

type Exit = { unknown?: boolean; interrupted?: boolean; exit_code?: number; signal?: NodeJS.Signals; error?: string };
interface WorkerInput {
  spec: unknown;
  argv?: string[];
  completion: string;
  env: NodeJS.ProcessEnv;
  hookEnv?: NodeJS.ProcessEnv;
  lastMessageFile?: string;
  hookReportFile?: string;
  redactions?: string[];
  interactive?: { provider: JobEngineConfig; stateDir: string; gitPaths: string[]; instructions?: string };
}

function runCommand(argv: string[], cwd: string, env: NodeJS.ProcessEnv, capture?: (chunk: Buffer) => void, hook?: boolean): Promise<Exit> {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", capture ? "pipe" : "inherit", hook ? "pipe" : "inherit"], shell: false });
  child.stdout?.on("data", capture!);
  child.stderr?.on("data", capture!);
  return new Promise(resolve => {
    child.once("error", () => resolve({ error: msg("worker.could_not_start_program") }));
    child.once("close", (code, signal) => resolve({ exit_code: code ?? undefined, signal: signal ?? undefined }));
  });
}

async function runHook(when: "before" | "after", hook: PlanHook, cwd: string, env: NodeJS.ProcessEnv,
  complete: (result: Exit) => void): Promise<Exit | undefined> {
  let tail = Buffer.alloc(0);
  const capture = (chunk: Buffer) => {
    process.stderr.write(chunk);
    tail = Buffer.concat([tail, chunk]).subarray(-2048);
  };
  process.stderr.write(`\n[Lumio ${when} hook]\n`);
  const timeout = setTimeout(() => {
    complete({ error: msg("worker.hook_timeout", when, tail.toString().trim()) });
    // Runtime starts this worker in its own process group, including the hook and its descendants.
    process.kill(-process.pid, "SIGKILL");
  }, (hook.timeout_minutes ?? DEFAULT_HOOK_TIMEOUT_MINUTES) * 60_000);
  try {
    const result = await runCommand(hook.argv, cwd, env, capture, true);
    if (result.exit_code === 0) return;
    return { ...result, error: msg("worker.hook_failed", when, tail.toString().trim() || result.error || result.signal || result.exit_code) };
  } finally { clearTimeout(timeout); }
}

// The parent releases stdin only after it has durably recorded this process group.
// EOF before release means the parent died; no user command has started.
export async function runWorker() {
  const input = await new Response(Bun.stdin.stream()).text();
  if (!input) return;
  const { spec: raw, argv: rawArgv, completion, env, hookEnv, lastMessageFile, hookReportFile, redactions = [], interactive }: WorkerInput = JSON.parse(input);
  const spec = JobSpec.parse(raw), run = spec.run;
  const argv = rawArgv?.length ? rawArgv : run.kind === "command" ? run.argv : [];
  if (!argv.length && !interactive) return;
  const phase = (value: string) => { if (process.connected) process.send?.({ phase: value }); };
  const complete = (result: Exit) => {
    writeFileSync(completion, JSON.stringify(result), { mode: 0o600 });
    if (process.connected) process.disconnect?.();
  };
  const redact = (value: string) => redactions.reduce((clean, secret) => clean.replaceAll(secret, "[REDACTED]"), value);
  const execute = async (capture?: (chunk: Buffer) => void): Promise<Exit> => {
    phase("engine");
    if (!interactive || run.kind !== "agent") return runCommand(argv, spec.workdir, env, capture);
    try {
      const result = await runInteractive({ ...interactive, job: spec.id, cwd: spec.workdir, run, env, lastMessageFile, redact });
      return { exit_code: result.exit_code, unknown: result.unknown, interrupted: result.interrupted };
    } catch { return { exit_code: 1, error: msg("executor.interactive_unavailable") }; }
  };
  if (run.kind !== "agent" || !run.hooks) { complete(await execute()); return; }

  const stage = stageId(run.prompt);
  const context = { ...hookEnv, LUMIO_WORKDIR: spec.workdir, ...(stage ? { LUMIO_STAGE_ID: stage } : {}),
    ...(spec.source?.task ? { LUMIO_TASK_ID: spec.source.task } : {}),
    ...(spec.source ? { LUMIO_ROUND: String(spec.source.round) } : {}) };
  if (run.hooks.before) {
    phase("before_hook");
    const failure = await runHook("before", run.hooks.before, spec.workdir, context, complete);
    if (failure) { complete(failure); return; }
  }

  const output = new JobOutput(run.engine, spec.workdir);
  const stdout: Buffer[] = [];
  let size = 0;
  const capture = run.hooks.after ? (chunk: Buffer) => {
    process.stdout.write(chunk);
    output.push(chunk);
    const keep = chunk.subarray(0, Math.max(0, 4 * 1024 * 1024 - size));
    if (keep.length) { stdout.push(keep); size += keep.length; }
  } : undefined;
  const result = await execute(capture);
  output.push(Buffer.alloc(0), true);
  if (result.exit_code !== 0 || result.interrupted || !run.hooks.after || !hookReportFile) { complete(result); return; }

  let lastMessage: string | undefined;
  try { if (lastMessageFile) lastMessage = readFileSync(lastMessageFile, "utf8"); } catch { /* Other engines use stdout. */ }
  const report = output.report ?? ADAPTERS[run.engine].parse(Buffer.concat(stdout).toString(), lastMessage, run).report ?? "";
  const sanitized = redact(report);
  writeFileSync(hookReportFile, sanitized, { mode: 0o600 });
  phase("after_hook");
  const failure = await runHook("after", run.hooks.after, spec.workdir, { ...context, LUMIO_REPORT_FILE: hookReportFile }, complete);
  complete(failure ?? result);
}
