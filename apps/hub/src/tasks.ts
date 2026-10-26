import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  CoreError, entityDirectory, humanPart, parseFrontmatter, scanVault, setFields, showNote, upsertBlock,
  type GitTrailers,
} from "@lumio/core";
import { textContainsCardNumber, type AgentRun, type Job, type Operation, type RuntimeInfo } from "@lumio/schema";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import type { Jobs } from "./jobs.ts";
import type { HubStore, Identity } from "./store.ts";
import type { WatchClock } from "./watch.ts";
import { editNote } from "./commit.ts";

/**
 * 任务笔记里的一问一答（ADR 0019 第 2、3、4 节，P2-4）。
 *
 * - 人把 `turn` 改成 `agent` → 笔记安静 `quietMs` 后派出下一轮（`task.dispatch`，trigger `turn`）。
 * - `lumio task continue` → 立即派出（trigger `cli`，经 /v1/operations）。
 * - 一轮的结果写回笔记里的一个 AI 区块，`turn` 改回 `human`。
 * - 程序状态（上次看到的 turn、会话编号、派出时的快照、轮数）存在 hub.sqlite，不写进笔记。
 *
 * 所有读写笔记的动作都在 Hub 的写入队列里执行（与补全、自动保存串行）。
 */

export interface TaskOptions { clock?: WatchClock; quietMs?: number; tickMs?: number }
type TaskTrigger = Extract<Operation, { op: "task.dispatch" }>["args"]["trigger"];
interface TaskState { task: string; path: string; last_turn: string | null; session: string | null; snapshot: string | null; rounds: number; pending_since: number | null }

const TASK_ID = /^task_[0-9A-HJKMNP-TV-Z]{26}$/;
/** 写回笔记前检查的常见密钥格式（ADR 0019 第 7 节）。 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bsk-ant-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\blumio_[A-Za-z0-9_-]{43}\b/,
];
export function containsSecret(text: string): boolean {
  return textContainsCardNumber(text) || SECRET_PATTERNS.some((p) => p.test(text));
}
const MAX_SUMMARY = 3000;

export const INSTRUCTIONS = (fields: { round: number; title: string; id: string; workdir: string }) => `你正在为用户的一个任务工作，这是第 ${fields.round} 轮。
任务：${fields.title}（${fields.id}）
工作目录：${fields.workdir}

要求：
- 只在工作目录内工作。不要读写用户的 Lumio 笔记库，需要 root 时运行 \`lumio-runtime sudo -- <命令>\` 并等待用户批准（可能要等很久，也可能被拒绝）；不要直接使用 sudo。
- 完成后，用中文简要汇报：做了什么、改了哪些文件、结果如何、还有什么遗留问题。
- 如果需要用户做决定才能继续，在最后的回复里用 <lumio-question>你的问题</lumio-question> 写出问题，然后结束这一轮，不要自行假设。
`;

/** 按行比较两个版本，返回新增与删除的行（LCS）。 */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const a = before.split("\n"), b = after.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const added: string[] = [], removed: string[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) removed.push(a[i++]!); else added.push(b[j++]!);
  }
  while (i < a.length) removed.push(a[i++]!);
  while (j < b.length) added.push(b[j++]!);
  return { added: added.filter((l) => l.trim()), removed: removed.filter((l) => l.trim()) };
}


/** workdir（可以 ~ 开头）是否落在笔记库里（ADR 0019：不允许）。 */
export function workdirInVault(vault: string, workdir: string): boolean {
  const expanded = workdir === "~" ? homedir() : workdir.startsWith("~/") ? join(homedir(), workdir.slice(2)) : workdir;
  const inside = relative(resolve(vault), resolve(expanded));
  return !inside || (!inside.startsWith("..") && !inside.startsWith("/"));
}

/**
 * 选执行器：`device` 给出时用它；否则挑在线且装了该 agent 的；都不在线就交给最近见过的那个，它上线后领取（相当于在 Hub 排队）。
 * 找不到时抛出以"没有可用的执行器"开头的错误。
 */
export function pickRuntime(store: HubStore, now: Date, engine: AgentRun["engine"], device: string | undefined): RuntimeInfo {
  const all = store.runtimes(now);
  const runtimes = all.filter((r) => r.registration.engines.some((e) => e.name === engine));
  const runtime = device ? all.find((r) => r.registration.name === device)
    : runtimes.find((r) => r.online) ?? [...runtimes].sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))[0];
  if (!runtime) throw new HubError("INVALID", device ? `没有可用的执行器：${device} 未登记` : `没有可用的执行器：没有登记过装了 ${engine} 的执行器`);
  if (!runtime.registration.engines.some((e) => e.name === engine)) throw new HubError("INVALID", `执行器 ${runtime.registration.name} 上没有登记 ${engine}`);
  return runtime;
}

export const OUTCOME: Record<string, string> = {
  done: "完成", waiting_for_human: "有问题等你回答", unknown: "情况不明", cancelled: "已取消",
};

export class TaskRounds {
  private lastChange = new Map<string, number>();
  private timer: unknown;
  private stopped = false;
  private readonly clock: WatchClock;
  private readonly quietMs: number;
  private readonly tickMs: number;

  constructor(private config: HubConfig, private store: HubStore, private jobs: Jobs,
    private run: <T>(action: () => Promise<T>) => Promise<T>, private issue: (path: string, line: string) => void,
    options: TaskOptions = {}) {
    this.clock = options.clock ?? { now: Date.now, set: (cb, ms) => setTimeout(cb, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
    this.quietMs = options.quietMs ?? 30_000;
    this.tickMs = options.tickMs ?? 5_000;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS task_state (task TEXT PRIMARY KEY, path TEXT NOT NULL, last_turn TEXT, session TEXT,
        snapshot TEXT, rounds INTEGER NOT NULL DEFAULT 0, pending_since INTEGER);
      CREATE TABLE IF NOT EXISTS task_rounds (job TEXT PRIMARY KEY, task TEXT NOT NULL, round INTEGER NOT NULL, written INTEGER NOT NULL DEFAULT 0);
    `);
  }

  /** 启动时把所有任务笔记过一遍：Hub 没运行期间人改了 turn 的，照样能派出。 */
  async start(): Promise<void> {
    for (const file of await scanVault(this.config.vault, ["task"])) await this.noteChanged(file.relativePath);
    this.schedule();
  }
  stop() { this.stopped = true; if (this.timer !== undefined) this.clock.clear(this.timer); }
  private schedule() {
    if (this.stopped) return;
    this.timer = this.clock.set(() => { void this.run(() => this.tick()).catch(() => {}).finally(() => this.schedule()); }, this.tickMs);
  }

  private state(task: string): TaskState | undefined {
    return this.store.db.query<TaskState, [string]>("SELECT * FROM task_state WHERE task=?").get(task) ?? undefined;
  }
  private save(s: TaskState) {
    this.store.db.query(`INSERT INTO task_state VALUES ($task,$path,$last_turn,$session,$snapshot,$rounds,$pending_since)
      ON CONFLICT(task) DO UPDATE SET path=$path,last_turn=$last_turn,session=$session,snapshot=$snapshot,rounds=$rounds,pending_since=$pending_since`)
      .run({ task: s.task, path: s.path, last_turn: s.last_turn, session: s.session, snapshot: s.snapshot, rounds: s.rounds, pending_since: s.pending_since });
  }
  private owner(): Identity | undefined {
    const actor = this.store.actors().find((a) => a.role === "human");
    return actor ? { actor, label: "vault" } : undefined;
  }

  /** 文件监听处理完一篇笔记之后调用（已在写入队列里，不能再排队）。 */
  async noteChanged(path: string): Promise<void> {
    if (!path.startsWith(`${entityDirectory("task")}/`) || !path.endsWith(".md")) return;
    let data: Record<string, unknown>;
    try { data = parseFrontmatter(await readFile(join(this.config.vault, path))).data; } catch { return; }
    const id = data.id;
    if (typeof id !== "string" || !TASK_ID.test(id)) return;
    const now = this.clock.now();
    this.lastChange.set(path, now);
    const s = this.state(id) ?? { task: id, path, last_turn: null, session: null, snapshot: null, rounds: 0, pending_since: null };
    s.path = path;
    const active = this.jobs.activeForTask(id);
    const turn = typeof data.turn === "string" ? data.turn : null;
    if (active && (data.status === "paused" || data.status === "cancelled")) this.jobs.cancel(active.spec.id);
    if (turn === "agent" && s.last_turn !== "agent") {
      if (s.pending_since === null) s.pending_since = now;
    } else if (turn !== "agent") {
      if (turn === "human" && s.last_turn === "agent" && active) {
        this.issue(path, `跳过  ${path}  这一轮还在执行，turn 只能由 Hub 改回 human`);
      } else {
        s.pending_since = null;
        s.last_turn = turn;
      }
    }
    if (turn !== null && turn !== "agent" && turn !== "human") this.issue(path, `跳过  ${path}  turn 只能是 human 或 agent`);
    this.save(s);
  }

  /** 定时：派出已经安静够久的任务；把还没写回的结果写回笔记。 */
  async tick(): Promise<void> {
    const now = this.clock.now();
    for (const s of this.store.db.query<TaskState, []>("SELECT * FROM task_state WHERE pending_since IS NOT NULL").all()) {
      if (now - (this.lastChange.get(s.path) ?? s.pending_since!) < this.quietMs) continue;
      const owner = this.owner();
      if (!owner) { this.issue(s.path, `跳过  ${s.path}  Hub 中没有 human 身份，无法派出任务`); continue; }
      try {
        await this.dispatch(s.task, "turn", owner, now);
        this.store.audit(owner, JSON.stringify({ op: "task.dispatch", args: { task: s.task, trigger: "turn" } }), "allow", undefined, "applied");
      }
      catch (cause) {
        if (cause instanceof HubError && cause.code === "CONFLICT") { s.pending_since = null; s.last_turn = "agent"; this.save(s); continue; }
        if (cause instanceof HubError && cause.message.startsWith("没有可用的执行器")) continue; // 等执行器上线
        await this.refuse(s, cause instanceof HubError || cause instanceof CoreError ? cause.message : "无法派出任务");
      }
    }
    await this.writeResults();
  }

  /** 派不出去：写一个说明区块，turn 交回给人，避免每次 tick 重复尝试。 */
  private async refuse(s: TaskState, message: string) {
    s.pending_since = null; s.last_turn = "human"; this.save(s);
    this.issue(s.path, `跳过  ${s.path}  ${message}`);
    await this.edit(s.path, (bytes) => setFields(upsertBlock(bytes, "dispatch-error", "", `### 无法派出\n${message}`), { turn: "human" }));
  }

  /** 派出下一轮。调用方负责在写入队列中执行、已通过授权，并写审计。 */
  async dispatch(task: string, trigger: TaskTrigger, identity: Identity, nowMs = this.clock.now()): Promise<Job> {
    const now = new Date(nowMs);
    let s = this.state(task);
    if (!s) {
      let note;
      try { note = await showNote(this.config.vault, task, { stateDir: this.config.stateDir }); }
      catch { throw new HubError("NOT_FOUND", "找不到这个任务"); }
      s = { task, path: note.note.path, last_turn: null, session: null, snapshot: null, rounds: 0, pending_since: null };
    }
    const bytes = await readFile(join(this.config.vault, s.path));
    const parsed = parseFrontmatter(bytes);
    const data = parsed.data;
    if (data.id !== task) throw new HubError("CONFLICT", "任务笔记在处理中被修改，请重试");
    const assignee = data.assignee as { agent?: unknown; device?: unknown } | undefined;
    if (!assignee || typeof assignee !== "object" || typeof assignee.agent !== "string") throw new HubError("INVALID", "任务的负责人不是 agent（assignee: {agent: …}）");
    const engine = assignee.agent as AgentRun["engine"];
    if (!["codex", "claude-code", "pi"].includes(engine)) throw new HubError("INVALID", `未知的 agent：${engine}`);
    if (typeof data.workdir !== "string" || !data.workdir) throw new HubError("INVALID", "任务没有写 workdir（执行器上的工作目录）");
    if (this.jobs.activeForTask(task)) throw new HubError("CONFLICT", "这个任务已有一轮在执行");
    if (workdirInVault(this.config.vault, data.workdir)) throw new HubError("INVALID", "工作目录不能在笔记库里（ADR 0019）");
    const runtime = pickRuntime(this.store, now, engine, typeof assignee.device === "string" ? assignee.device : undefined);

    const round = s.rounds + 1;
    const previous = this.jobs.list(undefined, task).at(-1);
    const human = humanPart(parsed.body.toString("utf8"));
    const title = typeof data.title === "string" ? data.title : task;
    let session: AgentRun["session"];
    if (engine === "pi") session = { id: task, resume: s.rounds > 0 };
    else if (s.session) session = { id: s.session, resume: true };
    else if (engine === "claude-code") session = { id: randomUUID(), resume: false };
    const resumable = Boolean(session?.resume);
    let content: string;
    if (round === 1 || !s.snapshot) content = `# ${title}\n\n${human}`;
    else if (resumable) {
      const { added, removed } = lineDiff(s.snapshot, human);
      content = added.length || removed.length
        ? `上一轮之后，用户在任务笔记里更新了下面的内容：\n${added.length ? `\n新增或修改：\n${added.map((l) => `+ ${l}`).join("\n")}\n` : ""}${removed.length ? `\n删除：\n${removed.map((l) => `- ${l}`).join("\n")}\n` : ""}`
        : "用户没有补充新内容，请在上一轮的基础上继续。";
    } else {
      const last = previous?.result?.report;
      content = `# ${title}\n\n${human}${last ? `\n\n## 上一轮的汇报\n\n${last.slice(0, 20_000)}` : ""}`;
    }
    // 从例行任务开出的追问（P2-5）：那一次的汇报放在 routine-run 区块里，人写的部分不含它；没接上会话时附上。
    const origin = /<!--\s*lumio:ai start name=routine-run job=(job_[0-9A-HJKMNP-TV-Z]{26})/.exec(parsed.body.toString("utf8"))?.[1];
    if (origin && !resumable) {
      let report: string | undefined;
      try { report = this.jobs.get(origin).result?.report; } catch { /* 记录已不在 */ }
      if (report) content += `\n\n## 例行任务那一次的汇报\n\n${report.slice(0, 20_000)}`;
    }
    const prompt = `${INSTRUCTIONS({ round, title, id: task, workdir: data.workdir })}\n${content}\n`;
    const timeout = typeof data.timeout_minutes === "number" && data.timeout_minutes > 0 ? data.timeout_minutes * 60 : 7200;
    const gpus = Array.isArray(data.gpus) && data.gpus.every((g) => Number.isInteger(g) && g >= 0) ? data.gpus as number[] : undefined;
    const job = this.jobs.create({
      runtime: runtime.actor, workdir: data.workdir, timeout_seconds: timeout, ...(gpus ? { gpus } : {}),
      run: { kind: "agent", engine, prompt, ...(typeof data.model === "string" && data.model ? { model: data.model } : {}), ...(session ? { session } : {}) },
      source: { task, round, ...(previous ? { previous: previous.spec.id } : {}) },
    }, now);
    if (engine === "claude-code" && session && !session.resume) s.session = session.id;
    s.rounds = round; s.snapshot = human; s.pending_since = null; s.last_turn = "agent";
    this.save(s);
    this.store.db.query("INSERT OR IGNORE INTO task_rounds VALUES (?, ?, ?, 0)").run(job.spec.id, task, round);
    await this.edit(s.path, (b) => {
      const d = parseFrontmatter(b).data;
      const patch: Record<string, string> = {};
      if (d.turn !== "agent") patch.turn = "agent";
      if (d.status === undefined || d.status === null || d.status === "todo") patch.status = "active";
      return Object.keys(patch).length ? setFields(b, patch) : b;
    }, { message: `lumio: task.dispatch ${title} 第 ${round} 轮`, trailers: { "Lumio-Actor": identity.actor.id, "Lumio-Job": job.spec.id } });
    return job;
  }

  /** 把已有结果、还没写回的轮次写进笔记。失败（如文件正在被改）留到下次 tick。 */
  async writeResults(): Promise<void> {
    const rows = this.store.db.query<{ job: string; task: string; round: number }, []>("SELECT job, task, round FROM task_rounds WHERE written=0 ORDER BY rowid").all();
    for (const row of rows) {
      let job: Job;
      try { job = this.jobs.get(row.job); } catch { continue; }
      if (!job.result && job.status !== "cancelled") continue;
      const s = this.state(row.task);
      if (!s) { this.markWritten(row.job); continue; }
      const block = this.render(job, row.round);
      try {
        await this.edit(s.path, (b) => setFields(upsertBlock(b, `round-${row.round}`, `job=${job.spec.id}`, block), { turn: "human" }),
          { message: `lumio: 第 ${row.round} 轮结果 ${job.status}`, trailers: { "Lumio-Actor": job.spec.runtime, "Lumio-Job": job.spec.id } });
      } catch (cause) {
        if (cause instanceof CoreError && cause.code === "FILE_CHANGED") continue;
        this.issue(s.path, `跳过  ${s.path}  无法写回第 ${row.round} 轮的结果`);
        continue;
      }
      s.last_turn = "human";
      if (job.result?.session_id) s.session = job.result.session_id;
      this.save(s);
      this.markWritten(row.job);
    }
  }
  private markWritten(job: string) { this.store.db.query("UPDATE task_rounds SET written=1 WHERE job=?").run(job); }

  private render(job: Job, round: number): string {
    const r = job.result;
    const status = r?.status ?? "cancelled";
    const title = status === "failed" ? `失败：${r?.error ?? (r?.exit_code !== undefined ? `退出码 ${r.exit_code}` : "未知原因")}` : OUTCOME[status] ?? status;
    const runtime = this.store.runtimes(new Date()).find((x) => x.actor === job.spec.runtime)?.registration.name ?? job.spec.runtime;
    const engine = r?.engine ? `${r.engine.name} ${r.engine.version} · ${r.engine.sandbox === "os" ? "系统沙箱" : "无沙箱"}` : job.spec.run.kind === "agent" ? job.spec.run.engine : "command";
    const time = (t?: string) => t ? t.slice(0, 16).replace("T", " ") : "—";
    const lines = [`### 第 ${round} 轮 · ${title}`, "", `（${engine} · ${runtime} · ${time(r?.started)} → ${time(r?.finished)}）`, ""];
    const report = r?.report ?? "";
    const question = r?.question;
    if (containsSecret(report) || (question && containsSecret(question))) {
      lines.push("汇报中疑似包含敏感信息（密钥或卡号），未写入笔记。请用 `lumio job show " + job.spec.id + "` 查看。");
    } else {
      if (report) lines.push(report.length > MAX_SUMMARY ? `${report.slice(0, MAX_SUMMARY)}\n\n……（已截断）` : report, "");
      if (question) lines.push(`> **问题**：${question}`, "");
    }
    if (r?.git?.before || r?.git?.after) {
      lines.push(`git：${r.git.before?.commit.slice(0, 8) ?? "—"} → ${r.git.after?.commit.slice(0, 8) ?? "—"}${r.git.after?.dirty ? "（有未提交的改动）" : ""}`);
    }
    lines.push(`完整汇报：\`lumio job show ${job.spec.id}\``);
    const block = lines.join("\n");
    // error、版本等元数据同样来自执行器，检查最终区块而不是只检查 report/question。
    if (containsSecret(block)) return `### 结果未写入\n\n汇报中疑似包含敏感信息（密钥或卡号），未写入笔记。请用 \`lumio job show ${job.spec.id}\` 查看。`;
    return block;
  }

  private async edit(path: string, change: (bytes: Buffer) => Buffer, commit?: { message: string; trailers: GitTrailers }): Promise<void> {
    await editNote(this.config.vault, path, change, commit, () => this.issue(path, `跳过  ${path}  Hub 的写入已完成，但未能单独提交，将由自动保存提交`));
  }
}
