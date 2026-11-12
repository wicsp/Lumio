import { serviceText, serviceErrorMessage, errorMessage, text as msg } from "./messages.ts";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { workdirInVault } from "./execution-policy.ts";
export { workdirInVault } from "./execution-policy.ts";
import { CoreError } from "@lumio/foundation";
import { entityDirectory, humanPart, parseFrontmatter, setFields, upsertBlock } from "@lumio/knowledge";
import { scanVault, showNote, type GitTrailers } from "@lumio/storage";
import { parseAssignee, type AgentRun, type Job, type Operation, type RuntimeInfo } from "@lumio/schema";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import type { Jobs } from "./jobs.ts";
import type { HubStore, Identity } from "./store.ts";
import type { WatchClock } from "./watch.ts";
import { editNote } from "./commit.ts";

/**
 * 任务笔记里的一问一答（ADR 0019 第 2、3、4 节，P2-4）。
 *
 * - 人把 `assignee` 改成 agent → 笔记安静 `quietMs` 后派出下一轮（`task.dispatch`，trigger `assignee`）。
 * - `lumio task continue` → 立即派出（trigger `cli`，经 /v1/operations）。
 * - 一轮的结果写回笔记里的一个 AI 区块；新笔记 assignee、旧笔记 turn 改回 human。
 * - 程序状态（上次看到的 assignee、会话编号、派出时的快照、轮数）存在 hub.sqlite，不写进笔记。
 *
 * 所有读写笔记的动作都在 Hub 的写入队列里执行（与补全、自动保存串行）。
 */

export interface TaskOptions { clock?: WatchClock; quietMs?: number; tickMs?: number; isManaged?: (path: string, id?: string) => boolean }
type TaskTrigger = Extract<Operation, { op: "task.dispatch" }>["args"]["trigger"];
interface TaskState { task: string; path: string; last_turn: string | null; session: string | null; snapshot: string | null; rounds: number; pending_since: number | null }

const TASK_ID = /^task_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_SUMMARY = 3000;

export const INSTRUCTIONS = (fields: { round: number; title: string; id: string; workdir: string }) => msg("tasks.you_are_working_on_round_of_a_user_task_task_working_directory_requi", fields.round, fields.title, fields.id, fields.workdir);

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


/** 未指定 device 时只使用 Hub 配置里的本机执行器。 */
export function pickRuntime(store: HubStore, now: Date, engine: AgentRun["engine"], device: string | undefined, localRuntime?: string): RuntimeInfo {
  const runtime = store.runtimes(now).find((r) => r.registration.name === (device ?? localRuntime));
  if (!runtime) throw new HubError("INVALID", device ? { key: "tasks.no_runtime_available_is_not_registered", args: [device] } : { key: "tasks.this_hub_has_no_local_runtime_specify_pi_runtime_name", args: [] });
  if (!runtime.registration.engines.some((e) => e.name === engine)) throw new HubError("INVALID", { key: "tasks.is_not_registered_on_runtime", args: [runtime.registration.name, engine] });
  return runtime;
}

export function assigneeKey(value: unknown): string {
  const a = parseAssignee(value ?? "human");
  return a === "human" ? a : `${a.agent}${a.device ? `@${a.device}` : ""}`;
}

/** 有旧开关的笔记继续按旧语义运行，避免升级扫描把固定负责人当成派活请求。 */
function taskAssignee(data: Record<string, unknown>): string {
  return Object.hasOwn(data, "turn") && data.turn !== "agent" ? "human" : assigneeKey(data.assignee);
}
const dispatchBlocked = (data: Record<string, unknown>) => ["done", "cancelled", "paused"].includes(String(data.status));
function handBack(bytes: Buffer): Buffer {
  return setFields(bytes, Object.hasOwn(parseFrontmatter(bytes).data, "turn") ? { turn: "human" } : { assignee: "human" });
}

export const OUTCOME: Record<string, string> = {
  done: msg("tasks.completed"), waiting_for_human: msg("tasks.waiting_for_your_answer"), unknown: msg("tasks.unknown"), cancelled: msg("tasks.cancelled"),
};

export class TaskRounds {
  private lastChange = new Map<string, number>();
  private timer: unknown;
  private stopped = false;
  private readonly clock: WatchClock;
  private readonly quietMs: number;
  private readonly tickMs: number;
  private readonly isManaged: NonNullable<TaskOptions["isManaged"]>;

  constructor(private config: HubConfig, private store: HubStore, private jobs: Jobs,
    private run: <T>(action: () => Promise<T>) => Promise<T>, private issue: (path: string, line: string) => void,
    options: TaskOptions = {}) {
    this.isManaged = options.isManaged ?? (() => false);
    this.clock = options.clock ?? { now: Date.now, set: (cb, ms) => setTimeout(cb, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
    this.quietMs = options.quietMs ?? 30_000;
    this.tickMs = options.tickMs ?? 5_000;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS task_state (task TEXT PRIMARY KEY, path TEXT NOT NULL, last_turn TEXT, session TEXT,
        snapshot TEXT, rounds INTEGER NOT NULL DEFAULT 0, pending_since INTEGER);
      CREATE TABLE IF NOT EXISTS task_rounds (job TEXT PRIMARY KEY, task TEXT NOT NULL, round INTEGER NOT NULL, written INTEGER NOT NULL DEFAULT 0);
    `);
  }

  /** 启动时把所有任务笔记过一遍：Hub 没运行期间人改了 assignee 的，照样能派出。 */
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
    if (this.isManaged(path)) return;
    let data: Record<string, unknown>;
    try { data = parseFrontmatter(await readFile(join(this.config.vault, path))).data; } catch { return; }
    const id = data.id;
    if (typeof id !== "string" || !TASK_ID.test(id)) return;
    if (this.isManaged(path, id)) return;
    const now = this.clock.now();
    this.lastChange.set(path, now);
    const s = this.state(id) ?? { task: id, path, last_turn: null, session: null, snapshot: null, rounds: 0, pending_since: null };
    s.path = path;
    const active = this.jobs.activeForTask(id);
    if (active && (data.status === "paused" || data.status === "cancelled")) this.jobs.cancel(active.spec.id);
    let assignee: string;
    if (!active && dispatchBlocked(data)) {
      s.pending_since = null; s.last_turn = "human"; this.save(s); return;
    }
    try {
      assignee = taskAssignee(data);
      // 升级前的 last_turn=agent 表示已派出，与当前的具体负责人 key 等价。
      if (Object.hasOwn(data, "turn") && s.last_turn === "agent") s.last_turn = assigneeKey(data.assignee);
    }
    catch (cause) { s.pending_since = null; this.issue(path, serviceText("tasks.skip", path, serviceErrorMessage(cause))); this.save(s); return; }
    if (active) {
      if (assignee !== s.last_turn) this.issue(path, serviceText("tasks.skip_this_round_is_still_running_changing_assignee_has_no_effect_unt", path));
      s.pending_since = null;
    } else {
      if (assignee !== "human" && assignee !== s.last_turn) s.pending_since = now;
      if (assignee === "human") s.pending_since = null;
      s.last_turn = assignee;
    }
    this.save(s);
  }

  /** 定时：派出已经安静够久的任务；把还没写回的结果写回笔记。 */
  async tick(): Promise<void> {
    const now = this.clock.now();
    for (const s of this.store.db.query<TaskState, []>("SELECT * FROM task_state WHERE pending_since IS NOT NULL").all()) {
      if (now - (this.lastChange.get(s.path) ?? s.pending_since!) < this.quietMs) continue;
      const owner = this.owner();
      if (!owner) { this.issue(s.path, serviceText("tasks.skip_hub_has_no_human_actor_cannot_dispatch_task", s.path)); continue; }
      try {
        await this.dispatch(s.task, "assignee", owner, now);
        this.store.audit(owner, JSON.stringify({ op: "task.dispatch", args: { task: s.task, trigger: "assignee" } }), "allow", undefined, "applied");
      }
      catch (cause) {
        if (cause instanceof HubError && cause.code === "CONFLICT") {
          s.pending_since = null; this.save(s);
          // 重新读取开关与状态；监听漏掉的暂停或交回不能留下陈旧的派活状态。
          await this.noteChanged(s.path); continue;
        }
        await this.refuse(s, cause instanceof HubError || cause instanceof CoreError ? errorMessage(cause) : msg("tasks.could_not_dispatch_task"));
      }
    }
    await this.writeResults();
  }

  /** 派不出去：写一个说明区块，assignee 交回给人，避免每次 tick 重复尝试。 */
  private async refuse(s: TaskState, message: string) {
    s.pending_since = null; s.last_turn = "human"; this.save(s);
    this.issue(s.path, serviceText("tasks.skip", s.path, message));
    await this.edit(s.path, (bytes) => handBack(upsertBlock(bytes, "dispatch-error", "", msg("tasks.could_not_dispatch", message))));
  }

  /** 派出下一轮。调用方负责在写入队列中执行、已通过授权，并写审计。 */
  async dispatch(task: string, trigger: TaskTrigger, identity: Identity, nowMs = this.clock.now(), to?: Extract<Operation, { op: "task.dispatch" }>["args"]["to"]): Promise<Job> {
    const now = new Date(nowMs);
    let s = this.state(task);
    if (!s) {
      let note;
      try { note = await showNote(this.config.vault, task, { stateDir: this.config.stateDir }); }
      catch { throw new HubError("NOT_FOUND", { key: "tasks.task_not_found", args: [] }); }
      s = { task, path: note.note.path, last_turn: null, session: null, snapshot: null, rounds: 0, pending_since: null };
    }
    if (this.isManaged(s.path, task)) throw new HubError("CONFLICT", { key: "tasks.this_source_is_managed_by_the_database_the_legacy_file_cannot_dispat", args: [] });
    const bytes = await readFile(join(this.config.vault, s.path));
    const parsed = parseFrontmatter(bytes);
    const data = parsed.data;
    if (data.id !== task) throw new HubError("CONFLICT", { key: "tasks.task_note_changed_during_processing_retry", args: [] });
    if (dispatchBlocked(data)) throw new HubError("CONFLICT", { key: "tasks.task_is_done_cancelled_or_paused_set_status_to_active_or_todo_first", args: [] });
    if (trigger === "assignee" && (taskAssignee(data) === "human" || taskAssignee(data) !== s.last_turn)) throw new HubError("CONFLICT", { key: "tasks.dispatch_setting_changed_waiting_for_the_next_trigger", args: [] });
    if (this.jobs.activeForTask(task)) throw new HubError("CONFLICT", { key: "tasks.this_task_already_has_an_active_round", args: [] });
    const previous = this.jobs.list(undefined, task).at(-1);
    let target: unknown = data.assignee ?? "human";
    if (trigger === "cli") {
      if (to !== undefined) target = to;
      else if (previous?.spec.run.kind === "agent") {
        const device = this.store.runtimes(now).find((r) => r.actor === previous.spec.runtime)?.registration.name;
        if (!device) throw new HubError("INVALID", { key: "tasks.the_previous_runtime_is_not_registered_specify_an_assignee_with_to_p", args: [] });
        target = `${previous.spec.run.engine}@${device}`;
      }
    }
    let assignee;
    try { assignee = parseAssignee(target); } catch (cause) { throw new HubError("INVALID", { key: "modules.specify_an_agent_e_g_pi_server", args: [] }); }
    if (assignee === "human") throw new HubError("INVALID", { key: "tasks.specify_an_agent_with_to_pi_server_cannot_dispatch_to_human", args: [] });
    const engine = assignee.agent;
    const workdir = data.workdir == null ? "~" : data.workdir;
    if (typeof workdir !== "string" || !workdir) throw new HubError("INVALID", { key: "tasks.workdir_must_be_a_non_empty_working_directory", args: [] });
    if (workdirInVault(this.config.vault, workdir)) throw new HubError("INVALID", { key: "tasks.working_directory_must_be_outside_the_vault_adr_0019", args: [] });
    const runtime = pickRuntime(this.store, now, engine, assignee.device, this.config.localRuntime);
    const targetKey = assigneeKey(target);

    const round = s.rounds + 1;
    const human = humanPart(parsed.body.toString("utf8"));
    const title = typeof data.title === "string" ? data.title : task;
    let session: AgentRun["session"];
    const sameAgent = previous?.spec.run.kind === "agent" && previous.spec.run.engine === engine && previous.spec.runtime === runtime.actor;
    if (sameAgent && s.session) session = { id: s.session, resume: true };
    else if (engine === "pi") session = { id: previous ? randomUUID() : task, resume: false };
    else if (engine === "claude-code") session = { id: randomUUID(), resume: false };
    const resumable = Boolean(session?.resume);
    let content: string;
    if (round === 1 || !s.snapshot) content = `# ${title}\n\n${human}`;
    else if (resumable) {
      const { added, removed } = lineDiff(s.snapshot, human);
      content = added.length || removed.length
        ? msg("tasks.the_user_updated_this_task_note_since_the_previous_round", added.length ? msg("tasks.added_or_changed", added.map((l) => `+ ${l}`).join("\n")) : "", removed.length ? msg("tasks.removed", removed.map((l) => `- ${l}`).join("\n")) : "")
        : msg("tasks.the_user_added_no_new_content_continue_from_the_previous_round");
    } else {
      const last = previous?.result?.report;
      content = `# ${title}\n\n${human}${last ? msg("tasks.previous_round_report", last.slice(0, 20_000)) : ""}`;
    }
    // 从例行任务开出的追问（P2-5）：那一次的汇报放在 routine-run 区块里，人写的部分不含它；没接上会话时附上。
    const origin = /<!--\s*lumio:ai start name=routine-run job=(job_[0-9A-HJKMNP-TV-Z]{26})/.exec(parsed.body.toString("utf8"))?.[1];
    if (origin && !resumable) {
      let report: string | undefined;
      try { report = this.jobs.get(origin).result?.report; } catch { /* 记录已不在 */ }
      if (report) content += msg("tasks.routine_run_report", report.slice(0, 20_000));
    }
    const prompt = `${INSTRUCTIONS({ round, title, id: task, workdir })}\n${content}\n`;
    const timeout = typeof data.timeout_minutes === "number" && data.timeout_minutes > 0 ? data.timeout_minutes * 60 : 7200;
    const gpus = Array.isArray(data.gpus) && data.gpus.every((g) => Number.isInteger(g) && g >= 0) ? data.gpus as number[] : undefined;
    const job = this.jobs.create({
      runtime: runtime.actor, workdir, timeout_seconds: timeout, ...(gpus ? { gpus } : {}),
      run: { kind: "agent", engine, prompt, ...(typeof data.model === "string" && data.model ? { model: data.model } : {}), ...(session ? { session } : {}) },
      source: { task, round, ...(previous ? { previous: previous.spec.id } : {}) },
    }, now);
    s.session = session?.id ?? null;
    s.rounds = round; s.snapshot = human; s.pending_since = null; s.last_turn = targetKey;
    this.save(s);
    this.store.db.query("INSERT OR IGNORE INTO task_rounds VALUES (?, ?, ?, 0)").run(job.spec.id, task, round);
    await this.edit(s.path, (b) => {
      const d = parseFrontmatter(b).data;
      const patch: Record<string, string> = {};
      if (trigger === "cli") {
        if (Object.hasOwn(d, "turn")) {
          patch.turn = "agent";
          // 指定不同负责人是人的显式修改；普通 continue 不改写旧对象。
          if (to !== undefined && assigneeKey(d.assignee) !== targetKey) patch.assignee = targetKey;
        } else patch.assignee = targetKey;
      }
      if (d.status === undefined || d.status === null || d.status === "todo") patch.status = "active";
      return Object.keys(patch).length ? setFields(b, patch) : b;
    }, { message: msg("tasks.lumio_task_dispatch_round", title, round), trailers: { "Lumio-Actor": identity.actor.id, "Lumio-Job": job.spec.id } });
    return job;
  }

  /** 把已有结果、还没写回的轮次写进笔记。失败（如文件正在被改）留到下次 tick。 */
  async writeResults(): Promise<void> {
    const rows = this.store.db.query<{ job: string; task: string; round: number }, []>("SELECT job, task, round FROM task_rounds WHERE written=0 ORDER BY rowid").all();
    for (const row of rows) {
      if (this.isManaged(this.state(row.task)?.path ?? "", row.task)) continue;
      let job: Job;
      try { job = this.jobs.get(row.job); } catch { continue; }
      if (!job.result && job.status !== "cancelled") continue;
      const s = this.state(row.task);
      if (!s) { this.markWritten(row.job); continue; }
      const block = this.render(job, row.round);
      try {
        await this.edit(s.path, (b) => handBack(upsertBlock(b, `round-${row.round}`, `job=${job.spec.id}`, block)),
          { message: msg("tasks.lumio_round_result", row.round, job.status), trailers: { "Lumio-Actor": job.spec.runtime, "Lumio-Job": job.spec.id } });
      } catch (cause) {
        if (cause instanceof CoreError && cause.code === "FILE_CHANGED") continue;
        this.issue(s.path, serviceText("tasks.skip_could_not_write_back_round_result", s.path, row.round));
        continue;
      }
      s.last_turn = "human"; s.pending_since = null;
      if (job.result?.session_id) s.session = job.result.session_id;
      this.save(s);
      this.markWritten(row.job);
    }
  }
  private markWritten(job: string) { this.store.db.query("UPDATE task_rounds SET written=1 WHERE job=?").run(job); }

  private render(job: Job, round: number): string {
    const r = job.result;
    const status = r?.status ?? "cancelled";
    const title = status === "failed" ? msg("tasks.failed_2", r?.error ?? (r?.exit_code !== undefined ? msg("tasks.exit_code", r.exit_code) : msg("tasks.unknown_reason"))) : OUTCOME[status] ?? status;
    const runtime = this.store.runtimes(new Date()).find((x) => x.actor === job.spec.runtime)?.registration.name ?? job.spec.runtime;
    const engine = r?.engine ? `${r.engine.name} ${r.engine.version} · ${r.engine.sandbox === "os" ? msg("jobs.os_sandbox") : msg("jobs.no_sandbox")}` : job.spec.run.kind === "agent" ? job.spec.run.engine : "command";
    const time = (t?: string) => t ? t.slice(0, 16).replace("T", " ") : "—";
    const lines = [msg("tasks.round_2", round, title), "", msg("(${0})", `${engine} · ${runtime} · ${time(r?.started)} → ${time(r?.finished)}`), ""];
    const report = r?.report ?? "";
    const question = r?.question;
    if (report) lines.push(report.length > MAX_SUMMARY ? msg("tasks.truncated", report.slice(0, MAX_SUMMARY)) : report, "");
    if (question) lines.push(msg("tasks.question", question), "");
    if (r?.git?.before || r?.git?.after) {
      lines.push(`git${msg(": ")}${r.git.before?.commit.slice(0, 8) ?? "—"} → ${r.git.after?.commit.slice(0, 8) ?? "—"}${r.git.after?.dirty ? msg("jobs.uncommitted_changes") : ""}`);
    }
    lines.push(msg("tasks.full_report_lumio_job_show", job.spec.id));
    return lines.join("\n");
  }

  private async edit(path: string, change: (bytes: Buffer) => Buffer, commit?: { message: string; trailers: GitTrailers }): Promise<void> {
    await editNote(this.config.vault, path, change, commit, () => this.issue(path, serviceText("tasks.skip_hub_wrote_changes_but_could_not_commit_them_separately_autosave", path)));
  }
}
