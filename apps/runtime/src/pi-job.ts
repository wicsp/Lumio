import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionId, type AgentRun } from "@lumio/schema";
import type { PiJobEngine } from "./job-engine-config.ts";
import type { WorkerJobControl } from "./job-control.ts";
import extension from "./pi-job-extension.mjs" with { type: "text" };

const MAX_LINE = 4 * 1024 * 1024;
type Wire = Record<string, any>;
type Input = {
  provider: PiJobEngine; workdir: string; root: string; job: string; roundDir: string; profile: string;
  run: AgentRun; env: NodeJS.ProcessEnv; instructions?: string; control: WorkerJobControl;
  emit(data: unknown): void; redact(value: string): string;
};

// Pi sends commands, session events, and extension UI records over the same private pipe.
class PiRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, (value?: Wire) => void>();
  private line = "";
  private skipping = false;
  onEvent?: (event: Wire) => void;
  onExit?: () => void;

  constructor(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.child.stdin.on("error", () => {});
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.push(chunk));
    const exit = () => {
      for (const done of this.pending.values()) done();
      this.onExit?.();
    };
    this.child.once("close", exit);
    this.child.once("error", exit);
  }

  private push(chunk: string) {
    const lines = chunk.split("\n");
    for (const [index, part] of lines.entries()) {
      if (!this.skipping && this.line.length + part.length <= MAX_LINE) this.line += part;
      else this.skipping = true;
      if (index === lines.length - 1) break;
      if (!this.skipping) {
        let record: Wire | undefined;
        try { record = JSON.parse(this.line); } catch { /* Non-protocol output. */ }
        if (record && typeof record === "object") {
          if (record.type === "response") this.pending.get(record.id)?.(record);
          else this.onEvent?.(record);
        }
      }
      this.line = "";
      this.skipping = false;
    }
  }

  send(record: Wire) {
    if (this.child.stdin.destroyed) throw new Error("Pi RPC disconnected");
    this.child.stdin.write(JSON.stringify(record) + "\n");
  }

  request(type: string, args: Wire = {}, timeout = 12_000): Promise<Wire> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (value?: Wire) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (value?.success === true && value.command === type) resolve(value.data ?? {});
        else reject(new Error("Pi RPC command failed"));
      };
      const timer = setTimeout(finish, timeout);
      this.pending.set(id, finish);
      try { this.send({ type, id, ...args }); } catch { finish(); }
    });
  }

  async close() {
    this.child.stdin.end();
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    let stop: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>(resolve => this.child.once("close", () => { clearTimeout(stop); resolve(); }));
    this.child.kill();
    stop = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    await closed;
  }
}

function metadata(value: unknown): Wire | undefined {
  if (typeof value !== "string" || value.length > 16_000) return;
  try {
    const data = JSON.parse(value);
    if (data?.source === "lumio-job" && typeof data.id === "string" && /^[a-f0-9-]{36}$/.test(data.id)) return data;
  } catch { /* The RPC also carries ordinary extension notifications. */ }
}

const safe = (value: unknown, limit: number, redact: Input["redact"]): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit && redact(value) === value
    && !/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);

function localEnv(input: Input, agentDir: string): NodeJS.ProcessEnv {
  const { provider, root, env, run } = input;
  return {
    ...env, HOME: root, TMPDIR: join(root, "tmp"), PI_CODING_AGENT_DIR: agentDir,
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(provider.node)}:${dirname(process.execPath)}`,
    LANG: "en_US.UTF-8", TERM: "dumb", SHELL: "/bin/bash",
    NODE_DISABLE_COMPILE_CACHE: "1", LUMIO_PI_READ_ONLY: run.permissions?.access === "read" ? "1" : "0",
    [provider.keyEnv]: provider.key,
  };
}

export async function runPi(input: Input): Promise<{ exit_code?: number; unknown?: boolean; session?: string; report?: string; interrupted?: boolean }> {
  const { provider, workdir, root, job, roundDir, profile, run, instructions, control, redact, emit } = input;
  const extensionFile = join(roundDir, "lumio-pi-extension.mjs");
  const sessions = join(root, "pi-sessions"), agentDir = join(root, `pi-agent-${job}`);
  const model = run.model?.includes("/") ? run.model : run.model ? `${provider.provider}/${run.model}` : provider.model;
  if (!model.startsWith(`${provider.provider}/`)) return { exit_code: 1 };
  await mkdir(agentDir, { mode: 0o700 });
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await writeFile(extensionFile, extension, { mode: 0o600, flag: "wx" });
  const argv = ["/usr/bin/sandbox-exec", "-p", profile, provider.node, provider.executable, "--mode", "rpc",
    "--no-approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--extension", extensionFile, "--provider", provider.provider, "--model", model,
    "--tools", run.permissions?.access === "read" ? "read,bash,grep,find,ls,lumio_ask_user" : "read,bash,edit,write,grep,find,ls,lumio_ask_user",
    "--session-dir", sessions, "--session-id", run.session?.id ?? randomUUID(),
    ...(instructions ? ["--append-system-prompt", instructions] : []),
  ];
  const rpc = new PiRpc(argv, workdir, localEnv(input, agentDir));
  const waiting = new Map<string, { request: string; action: string }>();
  const controller = new AbortController();
  let active = false, engineStarted = false, interrupted = false, failed = false, report = "", session = "";
  let finish: (result: { exit_code?: number; unknown?: boolean; session?: string; report?: string; interrupted?: boolean }) => void = () => {};
  const completed = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; });
  const dialog = async (event: Wire) => {
    if (typeof event.id !== "string" || event.id.length > 128) return;
    const reply = { type: "extension_ui_response", id: event.id };
    const details = metadata(event.title);
    if (!active || !details || waiting.has(details.id)) { rpc.send({ ...reply, cancelled: true }); return; }
    if (details.kind === "question" && (event.method === "input" || event.method === "select") && safe(details.text, 2000, redact)) {
      const options = event.method === "select" ? event.options : [];
      if (Array.isArray(options) && options.length <= 8 && options.every(value => safe(value, 480, redact)) && new Set(options).size === options.length) {
        const choice = await control.request({ kind: "question", questions: [{ id: "answer", text: details.text, options, multiple: false }] }, controller.signal, event.timeout);
        if (typeof choice.action === "object" && choice.action.action === "answer" && !controller.signal.aborted) {
          waiting.set(details.id, { request: choice.action.request_id, action: "answer" });
          rpc.send({ ...reply, value: choice.action.answers[0]?.values[0] });
          return;
        }
      }
    } else if (details.kind === "approval" && event.method === "confirm" && ["bash", "edit", "write"].includes(details.tool)) {
      const valid = safe(event.message, 8192, redact);
      const choice = await control.request({ kind: "approval", tool: details.tool === "bash" ? "Command" : details.tool === "edit" ? "Edit" : "Write",
        sandbox: "os", preview: valid ? event.message : "Details unavailable", can_approve: valid }, controller.signal, event.timeout);
      if (typeof choice.action === "object" && (choice.action.action === "approve" || choice.action.action === "deny") && !controller.signal.aborted) {
        waiting.set(details.id, { request: choice.action.request_id, action: choice.action.action });
        rpc.send({ ...reply, confirmed: choice.action.action === "approve" && valid });
        return;
      }
    }
    rpc.send({ ...reply, cancelled: true });
  };
  rpc.onExit = () => finish(active ? { unknown: true } : { exit_code: 1 });
  rpc.onEvent = event => {
    if (event.type === "extension_ui_request" && event.method === "notify") {
      const data = metadata(event.message), decision = data && waiting.get(data.id);
      if (decision) {
        waiting.delete(data!.id);
        control.receipt(decision.request, data!.applied === decision.action ? "applied" : "unknown");
      }
    } else if (event.type === "extension_ui_request") {
      void dialog(event).catch(() => finish({ unknown: active, exit_code: 1 }));
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      failed = event.message.stopReason === "error";
      const text = Array.isArray(event.message.content) ? event.message.content
        .filter((part: Wire) => part?.type === "text" && typeof part.text === "string").map((part: Wire) => part.text).join("\n") : "";
      if (text.trim()) report = redact(text).slice(0, 100_000);
      emit({ type: event.type, message: { role: "assistant", stopReason: event.message.stopReason, content: [{ type: "text", text: report }] } });
    } else if (event.type === "tool_execution_start") {
      emit({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, args: {
        command: event.args?.command === undefined ? undefined : redact(String(event.args.command)),
        path: event.args?.path === undefined ? undefined : redact(String(event.args.path)),
      } });
    } else if (event.type === "tool_execution_end") {
      emit({ type: event.type, toolCallId: event.toolCallId, isError: event.isError });
    } else if (event.type === "agent_start" || event.type === "auto_retry_start") {
      if (event.type === "agent_start") engineStarted = true;
      emit({ type: event.type });
    }
    else if (event.type === "agent_settled" && active) {
      finish({ exit_code: failed || (event.aborted && !interrupted) ? 1 : 0, session, report, interrupted });
    }
  };
  control.onStop(async () => {
    interrupted = true;
    controller.abort();
    if (!active) { finish({ exit_code: 1 }); return; }
    try {
      await rpc.request("abort", {}, 3500);
      finish({ exit_code: 0, interrupted: true, session, report });
    } catch { finish({ unknown: true }); }
  });
  try {
    const state = await rpc.request("get_state"), commands = await rpc.request("get_commands");
    const parsed = SessionId.safeParse(state.sessionId);
    if (!parsed.success || (run.session && parsed.data !== run.session.id) || !Array.isArray(commands.commands)
      || !commands.commands.some((value: Wire) => value.name === "lumio-job-ready" && value.source === "extension")) return { exit_code: 1 };
    if (interrupted) return { exit_code: 1 };
    session = parsed.data;
    control.bind({ instance: randomUUID(), session, turn: randomUUID() });
    emit({ type: "session", id: session });
    active = true;
    // The Pi prompt response can arrive after it starts making progress.
    const accepted = rpc.request("prompt", { message: run.prompt }, 90_000).then(() => completed);
    return await Promise.race([accepted, completed]);
  } catch { return engineStarted ? { unknown: true } : { exit_code: 1 }; }
  finally {
    controller.abort();
    for (const value of waiting.values()) control.receipt(value.request, "unknown");
    await rpc.close();
  }
}
