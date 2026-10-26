import type { AgentRun, RuntimeRegistration } from "@lumio/schema";

/**
 * 三个现成 agent 的非交互适配器（ADR 0019 第 7 节、P2-3）。
 *
 * 每个适配器只做翻译：把一轮 AgentRun 变成 argv，执行后从输出里取出最后的汇报与会话编号。
 * 它们不经过 shell，stdin 一律是 /dev/null（由 worker 保证）。
 *
 * 参数来自各 agent 的文档与本机验证，版本范围之外一律拒绝执行（ADR 0005 第 5 条）：不同版本的输出格式可能不同，
 * 不猜测。升级 agent 后需要先验证，再放宽这里的范围。
 */
export type EngineName = AgentRun["engine"];
export type Sandbox = RuntimeRegistration["engines"][number]["sandbox"];

export interface AgentContext {
  /** 这一轮的私有文件目录（执行器状态目录下），用于 agent 写出最后的回复。 */
  lastMessageFile: string;
}

export interface Adapter {
  engine: EngineName;
  command: string;
  sandbox: Sandbox;
  /** 验证过的版本范围：[min, below)。 */
  versions: { min: string; below: string };
  argv(run: AgentRun, ctx: AgentContext): string[];
  /** 从 stdout 与（可选的）最后回复文件中取出汇报与会话编号。取不到汇报时返回 undefined。 */
  parse(stdout: string, lastMessage: string | undefined, run: AgentRun): { report?: string; sessionId?: string };
}

const codex: Adapter = {
  engine: "codex", command: "codex", sandbox: "os",
  versions: { min: "0.160.0", below: "0.200.0" },
  argv(run, ctx) {
    const common = ["--skip-git-repo-check", "--sandbox", "workspace-write", "--json", "--output-last-message", ctx.lastMessageFile,
      ...(run.model ? ["-m", run.model] : [])];
    return run.session?.resume
      ? ["exec", "resume", ...common, run.session.id, run.prompt]
      : ["exec", ...common, run.prompt];
  },
  parse(stdout, lastMessage, run) {
    let sessionId: string | undefined;
    for (const line of stdout.split("\n")) {
      try {
        const event = JSON.parse(line) as { type?: string; thread_id?: string; session_id?: string };
        if (event.type === "thread.started" && event.thread_id) sessionId = event.thread_id;
        else if (!sessionId && event.session_id) sessionId = event.session_id;
      } catch { /* 非 JSON 行忽略 */ }
    }
    return { report: lastMessage?.trim() || undefined, sessionId: sessionId ?? (run.session?.resume ? run.session.id : undefined) };
  },
};

const claude: Adapter = {
  engine: "claude-code", command: "claude", sandbox: "none",
  versions: { min: "2.0.0", below: "3.0.0" },
  argv(run) {
    const session = run.session ? (run.session.resume ? ["--resume", run.session.id] : ["--session-id", run.session.id]) : [];
    // 无人值守：不允许交互式确认，否则一遇到权限询问就卡住。隔离级别如实声明为 none。
    return ["-p", run.prompt, "--output-format", "json", "--permission-mode", "bypassPermissions",
      ...(run.model ? ["--model", run.model] : []), ...session];
  },
  parse(stdout) {
    // --output-format json 输出一个 JSON 对象；容忍前后有日志行。
    for (const line of stdout.split("\n").reverse()) {
      try {
        const result = JSON.parse(line) as { type?: string; result?: unknown; session_id?: unknown };
        if (result.type === "result") {
          return { report: typeof result.result === "string" ? result.result : undefined,
            sessionId: typeof result.session_id === "string" ? result.session_id : undefined };
        }
      } catch { /* 继续向前找 */ }
    }
    return {};
  },
};

const pi: Adapter = {
  engine: "pi", command: "pi", sandbox: "none",
  versions: { min: "1.4.0", below: "2.0.0" },
  argv(run) {
    // pi 的 --session-id：不存在则新建，存在则打开，所以新建与继续用同一个参数。
    return ["-p", run.prompt, ...(run.model ? ["--model", run.model] : []), ...(run.session ? ["--session-id", run.session.id] : [])];
  },
  parse(stdout, _last, run) {
    return { report: stdout.trim() || undefined, sessionId: run.session?.id };
  },
};

export const ADAPTERS: Record<EngineName, Adapter> = { codex, "claude-code": claude, pi };

/** 比较 x.y.z（忽略预发布与构建后缀里的数字以外部分）。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(/[-+]/)[0]!.split(".").map((n) => Number(n));
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}

export function versionSupported(adapter: Adapter, version: string): boolean {
  return compareVersions(version, adapter.versions.min) >= 0 && compareVersions(version, adapter.versions.below) < 0;
}

/** 提问约定（P2-3）：agent 在最后的回复里用这个标记写出问题。 */
const QUESTION = /<lumio-question>([\s\S]*?)<\/lumio-question>/;

export function splitQuestion(report: string): { report: string; question?: string } {
  const match = QUESTION.exec(report);
  if (!match) return { report };
  const question = match[1]!.trim();
  return { report: report.replace(QUESTION, "").trim(), ...(question ? { question } : {}) };
}
