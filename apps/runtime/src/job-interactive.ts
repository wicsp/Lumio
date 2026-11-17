import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk/core";
import { JobHumanRequest, SessionId, type AgentRun, type JobControlTarget } from "@lumio/schema";
import { acquireStateLease } from "@lumio/storage";
import { isolatedEnvironment, seatbelt } from "./native/isolation.ts";
import type { CodexJobCredential } from "./native/connection-auth.ts";
import { NativeRpc, type Wire } from "./native/rpc.ts";
import { WorkerJobControl } from "./job-control.ts";
import { contains, type JobEngineConfig } from "./job-engine-config.ts";
import { text as msg } from "./messages.ts";
import { runPi } from "./pi-job.ts";
import { codexGitOptions } from "./stage.ts";

type Start = {
  provider: JobEngineConfig;
  stateDir: string;
  job: string;
  cwd: string;
  run: AgentRun;
  env: NodeJS.ProcessEnv;
  gitPaths: string[];
  instructions?: string;
  accountKey?: string;
  credential?(rejected?: string): Promise<CodexJobCredential>;
  lastMessageFile?: string;
  redact(value: string): string;
};
type EngineResult = { exit_code?: number; error?: string; unknown?: boolean; interrupted?: boolean; session?: string; report?: string };

const ipcUUID = () => randomUUID();
type Question = Extract<JobHumanRequest, { kind: "question" }>["questions"][number];
const emit = (data: unknown) => process.stdout.write(JSON.stringify(data) + "\n");
const normalized = (value: unknown, limit: number, redact: Start["redact"]): string | undefined => {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) return;
  const clean = redact(value);
  return clean === value ? clean : undefined;
};

function answers(questions: Question[], raw: unknown) {
  if (questions.length === 0 || questions.length > 4) return;
  const result = JobHumanRequest.safeParse({ kind: "question", id: "verification", target: {
    instance: "verification", session: "verification", turn: "verification",
  }, expires: new Date().toISOString(), questions });
  if (!result.success || result.data.kind !== "question" || !raw || new Set(questions.map(q => q.id)).size !== questions.length) return;
  return questions;
}

function readQuestions(raw: unknown, engine: "codex" | "claude-code", redact: Start["redact"]): Question[] | undefined {
  if (!Array.isArray(raw)) return;
  const list = raw.flatMap((q: Wire, i): Question[] => {
    if (!q || q.isSecret) return [];
    const text = normalized(q.question, 2000, redact);
    const id = engine === "codex" ? normalized(q.id, 128, redact) : String(i);
    const options: string[] = [];
    if (Array.isArray(q.options)) {
      for (const option of q.options) {
        const label = normalized(option?.label, 480, redact);
        if (!label || options.includes(label)) return [];
        options.push(label);
      }
    }
    return id && text ? [{ id, text, options, multiple: q.multiSelect === true }] : [];
  });
  return list.length === raw.length ? answers(list, raw) : undefined;
}

function scopedEnvironment(input: Start): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(input.env).filter(([k, value]) => value !== undefined &&
    (k === "LUMIO_HUB_URL" || k === "LUMIO_TOKEN" || k.startsWith("LUMIO_SUDO_") || k.startsWith("LUMIO_SECRET_") || k === "CUDA_VISIBLE_DEVICES")));
}
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function claudeShellWrapper(start: Start) {
  if (!start.lastMessageFile) throw new Error("Missing round directory");
  const path = join(dirname(start.lastMessageFile), "claude-shell");
  const variables = Object.entries(scopedEnvironment(start)).map(([name, value]) => `export ${name}=${shellQuote(value!)}`);
  await writeFile(path, ['#!/bin/sh', 'unset ANTHROPIC_API_KEY', ...variables, 'exec /bin/sh -c "$1"', ''].join("\n"), { mode: 0o700 });
  return shellQuote(path);
}
function cliEnvironment(input: Start, root: string, withClaudeKey: boolean): NodeJS.ProcessEnv {
  const scoped = scopedEnvironment(input);
  const { provider } = input;
  return {
    ...isolatedEnvironment(root, join(root, "codex"), provider.executable, input.env),
    ...scoped,
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(provider.executable)}:${dirname(process.execPath)}`,
    ...(withClaudeKey ? {
      ANTHROPIC_API_KEY: provider.key, CLAUDE_CONFIG_DIR: join(root, "claude"),
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    } : {}),
  };
}
function sandbox(input: Start, root: string) {
  const cwd = JSON.stringify(input.cwd);
  const extraReads = [
    input.cwd, dirname(process.execPath), ...input.gitPaths, "/private/var/empty",
    ...(input.provider.engine === "pi" ? [input.provider.packageRoot, dirname(input.provider.node)] : []),
    ...(input.lastMessageFile ? [dirname(input.lastMessageFile)] : []),
    ...(input.env.LUMIO_SUDO_SOCKET && isAbsolute(input.env.LUMIO_SUDO_SOCKET) ? [input.env.LUMIO_SUDO_SOCKET] : []),
  ];
  const allowedGit = input.gitPaths.map(path => `(require-not (subpath ${JSON.stringify(path)}))`).join(" ");
  return seatbelt(root, input.provider.executable, extraReads)
    + '(deny sysctl-read (sysctl-name "kern.procargs") (sysctl-name "kern.procargs2"))\n'
    + (input.run.permissions?.access === "read" ? "" : `(allow file-write* (subpath ${cwd}))\n`)
    + input.gitPaths.map(path => `(allow file-write* (subpath ${JSON.stringify(path)}))\n`).join("")
    + `(deny file-write* (require-all (regex #"/[.]git(/|$)") ${allowedGit || `(subpath ${cwd})`}))\n`;
}
type Context = {
  start: Start; root: string; profile: string; control: WorkerJobControl;
};

async function runCodex({ start, root, profile, control }: Context): Promise<EngineResult> {
  const { provider, run, cwd, redact } = start;
  const env = cliEnvironment(start, root, false);
  const git = start.gitPaths.length ? codexGitOptions(start.gitPaths, run.permissions?.access === "read", true) : [];
  const rpc = new NativeRpc(["/usr/bin/sandbox-exec", "-p", profile, provider.executable, "app-server", "--listen", "stdio://",
    "--enable", "default_mode_request_user_input", "-c", 'cli_auth_credentials_store="ephemeral"', ...git], cwd, env, false);
  const instance = ipcUUID();
  let thread = "", turn = "", report = "", done = false, interrupted = false;
  const applied = new Map<string | number, string>();
  const waiting = new Map<string | number, AbortController>();
  const changes = new Map<string, string[]>();
  let finish: (result: EngineResult) => void = () => {};
  let active = false, authFailed = false, accessHash: string | undefined;
  const credential = async (rejected?: string) => {
    if (!start.credential) throw new Error("Job account authorization unavailable");
    const material = await start.credential(rejected);
    accessHash = createHash("sha256").update(material.accessToken).digest("hex");
    return material;
  };
  const completion = new Promise<EngineResult>(resolve => { finish = resolve; });
  const sessionResult = () => SessionId.safeParse(thread).success ? thread : undefined;
  rpc.onExit = () => finish({ ...(active ? { unknown: true } : { exit_code: 1 }) });
  function bind(turnId: unknown) {
    if (!turn && typeof turnId === "string" && thread) {
      turn = turnId;
      control.bind({ instance, session: thread, turn });
    }
  }
  rpc.onEvent = (method, params) => {
    if (params.threadId && params.threadId !== thread) return;
    if (method === "serverRequest/resolved") {
      waiting.get(params.requestId)?.abort();
      const requestId = applied.get(params.requestId);
      if (requestId) { applied.delete(params.requestId); control.receipt(requestId, "applied"); }
      return;
    }
    if (params.turnId && turn && params.turnId !== turn) return;
    if (method === "turn/started") {
      bind(params.turn?.id);
      emit({ type: "turn.started" });
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item;
      if (!item) return;
      if (item.type === "agentMessage" && method === "item/completed" && typeof item.text === "string") report = item.text;
      if (item.type === "fileChange" && Array.isArray(item.changes)) {
        const files: string[] = item.changes.map((file: Wire) => file?.path);
        if (typeof item.id === "string" && changes.size < 256) changes.set(item.id, files);
      }
      const kind = ({ commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call",
        webSearch: "web_search", agentMessage: "agent_message", plan: "todo_list" } as Record<string, string>)[item.type];
      if (kind) emit({ type: method.replace("/", "."), item: {
        type: kind, id: item.id, command: item.command, status: item.status,
        ...(Array.isArray(item.changes) ? { changes: item.changes.map((file: Wire) => ({ path: file?.path })) } : {}),
      } });
    }
    if (method === "turn/completed" && params.turn?.id === turn) {
      done = true;
      finish({ exit_code: !authFailed && (params.turn.status === "completed" || (interrupted && params.turn.status === "interrupted")) ? 0 : 1,
        ...(authFailed ? { error: msg("executor.account_unavailable") } : {}), session: sessionResult(), report, interrupted });
    }
  };
  const deny = (method: string, id: string | number) => {
    if (method === "item/tool/requestUserInput") rpc.answer(id, { answers: {} });
    else if (method === "item/permissions/requestApproval") rpc.answer(id, { permissions: {}, scope: "turn" });
    else rpc.reject(id);
  };
  const ask = async (id: string | number, prompt: Parameters<WorkerJobControl["request"]>[0], timeout?: number) => {
    const controller = new AbortController();
    waiting.set(id, controller);
    try {
      const choice = await control.request(prompt, controller.signal, timeout);
      return controller.signal.aborted ? undefined : choice;
    } finally { waiting.delete(id); }
  };
  rpc.onRequest = (method, id, params) => {
    if (method === "account/chatgptAuthTokens/refresh" && start.credential && accessHash) {
      void credential(accessHash).then(material => rpc.answer(id, material)).catch(() => {
        authFailed = true;
        try { rpc.reject(id); } finally { void control.stop().catch(() => {}); }
      }).catch(() => {});
      return;
    }
    void (async () => {
      if (params.threadId !== thread || (turn && params.turnId !== turn) || typeof params.turnId !== "string") { deny(method, id); return; }
      bind(params.turnId);
      if (method === "item/tool/requestUserInput") {
        const questions = readQuestions(params.questions, "codex", redact);
        if (!questions) { deny(method, id); return; }
        const choice = await ask(id, { kind: "question", questions }, params.autoResolutionMs);
        if (!choice) return;
        if (typeof choice.action === "object") applied.set(id, choice.action.request_id);
        rpc.answer(id, { answers: typeof choice.action === "object" && choice.action.action === "answer"
          ? Object.fromEntries(choice.action.answers.map(answer => [answer.question, { answers: answer.values }])) : {} });
        return;
      }
      if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) { deny(method, id); return; }
      const command = method === "item/commandExecution/requestApproval";
      const location = typeof params.cwd === "string" ? await realpath(params.cwd).catch(() => undefined) : cwd;
      const files = changes.get(params.itemId);
      const inside = files?.every(file => typeof file === "string" && isAbsolute(file) && contains(cwd, file) && !file.split("/").includes(".git"));
      const preview = normalized(command ? params.command : inside ? files?.join("\n") : undefined, 8192, redact);
      const accepted = !Array.isArray(params.availableDecisions) || params.availableDecisions.includes("accept");
      const can_approve = !!preview && !!location && contains(cwd, location) && accepted && !params.grantRoot
        && !params.networkApprovalContext && !params.additionalPermissions && params.kind !== "writeStdin" && (command || run.permissions?.access !== "read");
      const choice = await ask(id, { kind: "approval", tool: command ? "Command" : "File changes",
        preview: preview ?? "Details unavailable", reason: normalized(params.reason, 1024, redact), can_approve, sandbox: "os" });
      if (!choice) return;
      if (typeof choice.action === "object") applied.set(id, choice.action.request_id);
      rpc.answer(id, { decision: typeof choice.action === "object" && choice.action.action === "approve" && can_approve ? "accept" : "decline" });
    })().catch(() => { try { deny(method, id); } catch { /* engine exited */ } });
  };
  control.onSteer = async text => {
    if (!turn || done) return false;
    const result = await rpc.request("turn/steer", { threadId: thread, expectedTurnId: turn, input: [{ type: "text", text }] }, 5000);
    return result.turnId === turn;
  };
  control.onStop(async () => {
    interrupted = true;
    if (turn && !done) await rpc.request("turn/interrupt", { threadId: thread, turnId: turn }, 5000);
    else finish({ exit_code: 1 });
  });
  try {
    await rpc.initialize();
    const material = start.credential ? await credential() : undefined;
    await rpc.request("account/login/start", material ? { type: "chatgptAuthTokens", ...material } : { type: "apiKey", apiKey: provider.key });
    const account = (await rpc.request("account/read", {})).account;
    if (material ? account?.type !== "chatgpt" || (account.accountId && account.accountId !== material.chatgptAccountId)
      : account?.type !== "apiKey") return { exit_code: 1 };
    const readOnly = run.permissions?.access === "read";
    const policy = {
      cwd, model: run.model, approvalPolicy: "on-request", approvalsReviewer: "user",
      ...(!start.gitPaths.length ? { sandbox: readOnly ? "read-only" : "workspace-write" } : {}),
      developerInstructions: [start.instructions, "Use the available user input tool when an answer is needed for this turn."].filter(Boolean).join("\n\n"),
      config: {
        "features.apps": false, "features.plugins": false, "features.hooks": false, "features.goals": false, "features.multi_agent": false,
        "features.browser_use": false, "features.computer_use": false, "mcp_servers": {},
        "shell_environment_policy.inherit": "all", "shell_environment_policy.ignore_default_excludes": true,
        "sandbox_workspace_write.network_access": true,
        "sandbox_workspace_write.exclude_slash_tmp": true, "sandbox_workspace_write.exclude_tmpdir_env_var": true,
      },
    };
    const opened = await rpc.request(run.session?.resume ? "thread/resume" : "thread/start", {
      ...policy, ...(run.session?.resume ? { threadId: run.session.id, excludeTurns: true } : {}),
    });
    const parsed = SessionId.safeParse(opened.thread?.id);
    if (!parsed.success || opened.approvalPolicy !== "on-request" || opened.approvalsReviewer !== "user") return { exit_code: 1 };
    thread = parsed.data;
    if (interrupted) return { exit_code: 1 };
    emit({ type: "thread.started", thread_id: thread });
    active = true;
    const reply = await rpc.request("turn/start", { threadId: thread, input: [{ type: "text", text: run.prompt }] });
    bind(reply.turn?.id);
    return await completion;
  } catch { return active ? { unknown: true } : { exit_code: 1 }; }
  finally {
    for (const request of applied.values()) control.receipt(request, "unknown");
    if (!await rpc.stop()) await control.stop();
  }
}

async function runClaude({ start, root, profile, control }: Context): Promise<EngineResult> {
  const { run, provider, cwd, redact } = start;
  const env = { ...cliEnvironment(start, root, true), CLAUDE_CODE_SHELL_PREFIX: await claudeShellWrapper(start) };
  const turn = ipcUUID(), instance = ipcUUID();
  const inFlight = new Map<string, string>();
  const controller = new AbortController();
  let session: string | undefined;
  let active = false, interrupted = false;
  const bind = (value: unknown) => {
    const parsed = SessionId.safeParse(value);
    if (!parsed.success || session === parsed.data) return;
    session = parsed.data;
    const target: JobControlTarget = { instance, session, turn };
    control.bind(target);
  };
  const allowed = ["Read", "Glob", "Grep", "Bash", "AskUserQuestion", ...(run.permissions?.access !== "read" ? ["Edit", "Write"] : [])];
  const host = query({
    prompt: run.prompt,
    options: {
      cwd, model: run.model, env, abortController: controller, settingSources: [], strictMcpConfig: true,
      permissionMode: "default", tools: allowed, mcpServers: {},
      settings: { permissions: { ask: allowed.filter(tool => ["Bash", "Edit", "Write"].includes(tool)) } },
      ...(run.session?.resume ? { resume: run.session.id } : run.session?.id ? { sessionId: run.session.id } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: start.instructions },
      extraArgs: { "disable-slash-commands": null, "no-chrome": null },
      pathToClaudeCodeExecutable: provider.executable,
      spawnClaudeCodeProcess: options => spawn("/usr/bin/sandbox-exec", ["-p", profile, provider.executable, ...options.args],
        { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"], shell: false }),
      canUseTool: async (toolName, input, context): Promise<PermissionResult> => {
        const deny: PermissionResult = { behavior: "deny", message: "Declined, unavailable, or expired" };
        if (!allowed.includes(toolName)) return deny;
        if (toolName === "AskUserQuestion") {
          const questions = readQuestions(input.questions, "claude-code", redact);
          if (!questions) return deny;
          const choice = await control.request({ kind: "question", questions }, context.signal);
          if (typeof choice.action !== "object") return deny;
          inFlight.set(context.toolUseID, choice.action.request_id);
          if (choice.action.action !== "answer") return deny;
          const responses = Object.fromEntries(choice.action.answers.map(answer =>
            [questions.find(question => question.id === answer.question)!.text, answer.values.join(", ")]));
          return { behavior: "allow", updatedInput: { questions: input.questions, answers: responses } };
        }
        const file = typeof input.file_path === "string" && isAbsolute(input.file_path) && contains(cwd, input.file_path)
          && !input.file_path.split("/").includes(".git") ? input.file_path : undefined;
        const preview = normalized(toolName === "Bash" ? input.command : file, 8192, redact);
        const can_approve = !!preview && ["Bash", "Edit", "Write"].includes(toolName);
        const choice = await control.request({ kind: "approval", tool: toolName,
          preview: preview ?? "Details unavailable", can_approve, sandbox: "os" }, context.signal);
        if (typeof choice.action !== "object") return deny;
        inFlight.set(context.toolUseID, choice.action.request_id);
        return can_approve && choice.action.action === "approve" ? { behavior: "allow", updatedInput: input } : deny;
      },
    },
  });
  control.onStop(async () => { interrupted = true; await host.interrupt(); });
  try {
    for await (const message of host) {
      if (message.type === "system" && message.subtype === "init") { bind(message.session_id); active = true; }
      if (message.type === "user" && Array.isArray(message.message.content)) {
        for (const item of message.message.content) if (item.type === "tool_result") {
          const request = inFlight.get(item.tool_use_id);
          if (request) { inFlight.delete(item.tool_use_id); control.receipt(request, "applied"); }
        }
      }
      if (message.type === "assistant" || message.type === "user") emit(message);
      else if (message.type === "system" && ["init", "api_retry"].includes(message.subtype)) emit({
        type: "system", subtype: message.subtype, session_id: "session_id" in message ? message.session_id : session,
      });
      if (message.type === "result") {
        emit(message);
        const report = message.subtype === "success" ? message.result : undefined;
        return { exit_code: message.is_error && !interrupted ? 1 : 0, session: message.session_id, report, interrupted };
      }
    }
    return { unknown: active };
  } catch { return active ? { unknown: true } : { exit_code: 1 }; }
  finally {
    for (const request of inFlight.values()) control.receipt(request, "unknown");
    host.close();
  }
}

export async function runInteractive(start: Start): Promise<EngineResult> {
  const sessions = join(start.stateDir, "job-engine-sessions");
  const cwd = await realpath(start.cwd);
  if (start.provider.engine !== start.run.engine || process.platform !== "darwin" || !start.provider.roots.some(root => contains(root, cwd))
    || contains(cwd, start.stateDir) || contains(start.stateDir, cwd) || start.run.permissions?.access === "full") return { exit_code: 1 };
  if (start.accountKey ? start.run.engine !== "codex" || !start.credential || start.provider.key : !start.provider.key) return { exit_code: 1 };
  const identity = start.accountKey ? { account: start.accountKey } : start.provider.engine === "pi"
    ? { provider: start.provider.provider, key: start.provider.key } : start.provider.key;
  const signature = createHash("sha256").update(JSON.stringify([cwd, start.run.engine, identity])).digest("hex");
  const lookup = (session: string) => join(sessions, createHash("sha256").update(session).digest("hex") + ".json");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  let name = start.job;
  if (start.run.session?.resume) {
    const saved = JSON.parse(await readFile(lookup(start.run.session.id), "utf8")) as { signature?: string; job?: string };
    if (saved.signature !== signature || !saved.job || !/^job_[0-9A-HJKMNP-TV-Z]{26}$/.test(saved.job)) return { exit_code: 1 };
    name = saved.job;
  }
  const root = join(sessions, name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lease = await acquireStateLease(root);
  const control = new WorkerJobControl();
  try {
    for (const key of ["tmp", "codex", "claude"]) await mkdir(join(root, key), { recursive: true, mode: 0o700 });
    const context = { start: { ...start, cwd }, root, profile: sandbox({ ...start, cwd }, root), control };
    const result = start.provider.engine === "pi"
      ? (start.lastMessageFile ? await runPi({ provider: start.provider, workdir: cwd, root, job: start.job,
        roundDir: dirname(start.lastMessageFile), profile: context.profile, run: start.run, env: scopedEnvironment(start),
        instructions: start.instructions, control, emit, redact: start.redact }) : { exit_code: 1 })
      : start.provider.engine === "codex" ? await runCodex(context) : await runClaude(context);
    if (result.session && result.exit_code === 0) await writeFile(lookup(result.session), JSON.stringify({ signature, job: name }), { mode: 0o600 });
    if (start.lastMessageFile && result.report) await writeFile(start.lastMessageFile, start.redact(result.report), { mode: 0o600 });
    return result;
  } finally { control.close(); lease.close(); }
}
