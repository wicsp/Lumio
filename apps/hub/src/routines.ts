import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  dueFires, entityDirectory, humanPart, idTime, newId, nextFire, parseCron, parseFrontmatter, routineJobId, scanVault, showNote,
  upsertBlock, validTimeZone, writeFileAtomic,
} from "@lumio/core";
import {
  JOB_PROTOCOL_VERSION, Job, NoteRef, Routine, RoutineInfo, RoutineSpec, type AgentRun,
} from "@lumio/schema";
import type { HubConfig } from "./config.ts";
import { editNote, writeAndCommit } from "./commit.ts";
import { HubError } from "./errors.ts";
import type { Jobs } from "./jobs.ts";
import type { HubStore, Identity } from "./store.ts";
import { OUTCOME, containsSecret, pickRuntime, workdirInVault } from "./tasks.ts";
import type { WatchClock } from "./watch.ts";

/**
 * 例行任务（ADR 0019 第 6 节，P2-5）。
 *
 * - Hub 把 `plan/routines/` 里每篇 `status: active` 的例行任务做成一份计划（RoutineSpec），同步给负责的执行器；
 *   到点由执行器自己触发（Hub 离线也照常），Job 编号由"例行任务 + 计划触发时间"确定。
 * - 执行器交回结果时，Hub 按编号认出它属于哪个例行任务（`adopt`），补建 Job 记录，再把结果按日期追加到这篇笔记。
 * - 程序状态（计划、lease、每一次的记录）存在 hub.sqlite，不写进笔记。
 */
export interface RoutineOptions { clock?: WatchClock; tickMs?: number; timezone?: string }
interface PlanRow {
  routine: string; path: string; title: string; status: string; schedule: string; timezone: string;
  runtime: string | null; lease: string | null; spec: string | null; problem: string | null;
}

const MAX_SUMMARY = 3000;
const ROUTINE_ID = /^rtn_[0-9A-HJKMNP-TV-Z]{26}$/;

export const ROUTINE_INSTRUCTIONS = (fields: { title: string; id: string; workdir: string }) => `你正在执行用户的一个例行任务（按计划自动触发，这是独立的一次，没有之前的对话）。
例行任务：${fields.title}（${fields.id}）
工作目录：${fields.workdir}

要求：
- 只在工作目录内工作。不要读写用户的 Lumio 笔记库，需要 root 时运行 \`lumio-runtime sudo -- <命令>\` 并等待用户批准（可能要等很久，也可能被拒绝）；不要直接使用 sudo。
- 完成后，用中文简要汇报结果；有需要用户注意的地方写在最前面。
- 如果需要用户做决定，在最后的回复里用 <lumio-question>你的问题</lumio-question> 写出问题，然后结束。
`;

/** 时区里的本地日期时间，`2026-10-26 09:00`。 */
export function localTime(iso: string, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export class Routines {
  private timer: unknown;
  private stopped = false;
  private readonly clock: WatchClock;
  private readonly tickMs: number;
  private readonly defaultZone: string;

  constructor(private config: HubConfig, private store: HubStore, private jobs: Jobs,
    private run: <T>(action: () => Promise<T>) => Promise<T>, private issue: (path: string, line: string) => void,
    options: RoutineOptions = {}) {
    this.clock = options.clock ?? { now: Date.now, set: (cb, ms) => setTimeout(cb, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
    this.tickMs = options.tickMs ?? 5_000;
    this.defaultZone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS routine_plans (routine TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        schedule TEXT NOT NULL, timezone TEXT NOT NULL, runtime TEXT, lease TEXT, spec TEXT, problem TEXT);
      CREATE TABLE IF NOT EXISTS routine_runs (job TEXT PRIMARY KEY, routine TEXT NOT NULL, fired_at TEXT NOT NULL, written INTEGER NOT NULL DEFAULT 0);
    `);
  }

  /** 启动时把所有例行任务过一遍；笔记已经不在的计划删掉。 */
  async start(): Promise<void> {
    const files = await scanVault(this.config.vault, ["routine"]);
    const seen = new Set(files.map((f) => f.relativePath));
    for (const row of this.rows()) if (!seen.has(row.path)) this.store.db.query("DELETE FROM routine_plans WHERE routine=?").run(row.routine);
    for (const file of files) await this.noteChanged(file.relativePath);
    this.schedule();
  }
  stop() { this.stopped = true; if (this.timer !== undefined) this.clock.clear(this.timer); }
  private schedule() {
    if (this.stopped) return;
    this.timer = this.clock.set(() => { void this.run(() => this.tick()).catch(() => {}).finally(() => this.schedule()); }, this.tickMs);
  }
  /** 定时：没有执行器的计划重新挑一次；写回还没写回的结果。 */
  async tick(): Promise<void> {
    for (const row of this.rows()) if (row.status === "active" && !row.spec && row.problem?.startsWith("没有可用的执行器")) await this.noteChanged(row.path);
    await this.writeResults();
  }

  private rows(): PlanRow[] { return this.store.db.query<PlanRow, []>("SELECT * FROM routine_plans ORDER BY path").all(); }
  private row(routine: string): PlanRow | undefined {
    return this.store.db.query<PlanRow, [string]>("SELECT * FROM routine_plans WHERE routine=?").get(routine) ?? undefined;
  }
  private saveRow(r: PlanRow) {
    this.store.db.query(`INSERT INTO routine_plans VALUES ($routine,$path,$title,$status,$schedule,$timezone,$runtime,$lease,$spec,$problem)
      ON CONFLICT(routine) DO UPDATE SET path=$path,title=$title,status=$status,schedule=$schedule,timezone=$timezone,runtime=$runtime,lease=$lease,spec=$spec,problem=$problem`)
      .run({ ...r });
  }

  /** 文件监听处理完一篇笔记之后调用（已在写入队列里）。 */
  async noteChanged(path: string): Promise<void> {
    if (!path.startsWith(`${entityDirectory("routine")}/`) || !path.endsWith(".md")) return;
    let bytes: Buffer;
    try { bytes = await readFile(join(this.config.vault, path)); }
    catch { this.store.db.query("DELETE FROM routine_plans WHERE path=?").run(path); return; }
    let data: Record<string, unknown>, body: string;
    try { const parsed = parseFrontmatter(bytes); data = parsed.data; body = parsed.body.toString("utf8"); } catch { return; }
    if (typeof data.id !== "string" || !ROUTINE_ID.test(data.id)) return; // 等补全 ID 之后再处理
    const id = data.id;
    // 同一篇笔记换了 ID：旧计划作废。
    this.store.db.query("DELETE FROM routine_plans WHERE path=? AND routine<>?").run(path, id);
    const previous = this.row(id);
    const title = typeof data.title === "string" ? data.title : basename(path, ".md");
    const row: PlanRow = {
      routine: id, path, title, status: data.status === "paused" ? "paused" : "active",
      schedule: typeof data.schedule === "string" ? data.schedule : "", timezone: typeof data.timezone === "string" && data.timezone ? data.timezone : this.defaultZone,
      runtime: null, lease: null, spec: null, problem: null,
    };
    const refuse = (problem: string) => {
      if (previous?.problem !== problem) this.issue(path, `跳过  ${path}  ${problem}`);
      this.saveRow({ ...row, problem });
    };
    const parsed = Routine.safeParse(data);
    if (!parsed.success) { refuse(`例行任务格式不对：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`); return; }
    const routine = parsed.data;
    try { parseCron(routine.schedule); } catch { refuse(`schedule 不合法：${routine.schedule}`); return; }
    if (!validTimeZone(row.timezone)) { refuse(`未知时区：${row.timezone}`); return; }
    if (row.status === "paused") { this.saveRow(row); return; }
    if (!routine.workdir) { refuse("例行任务没有写 workdir（执行器上的工作目录）"); return; }
    if (workdirInVault(this.config.vault, routine.workdir)) { refuse("工作目录不能在笔记库里（ADR 0019）"); return; }
    let runtime;
    try { runtime = pickRuntime(this.store, new Date(this.clock.now()), routine.assignee.agent, routine.assignee.device); }
    catch (cause) { refuse(cause instanceof HubError ? cause.message : "没有可用的执行器"); return; }

    let prompt = `${ROUTINE_INSTRUCTIONS({ title, id, workdir: routine.workdir })}\n# ${title}\n\n${humanPart(body)}\n`;
    if (routine.context === "previous") {
      const last = this.runs(id).filter((r) => r.job.result?.report).at(-1);
      if (last) prompt += `\n## 上一次的结果（${localTime(last.fired_at, row.timezone)}）\n\n${last.job.result!.report!.slice(0, MAX_SUMMARY)}\n`;
    }
    const run: AgentRun = { kind: "agent", engine: routine.assignee.agent, prompt, ...(routine.model ? { model: routine.model } : {}) };
    const template = { run, workdir: routine.workdir, ...(routine.gpus ? { gpus: routine.gpus } : {}), timeout_seconds: (routine.timeout_minutes ?? 120) * 60 };
    const revision = createHash("sha256").update(JSON.stringify({ schedule: routine.schedule, timezone: row.timezone, template })).digest("hex").slice(0, 16);
    // lease 跟着"例行任务 + 执行器"走：换了执行器才换 lease，旧执行器交回的结果随之作废。
    const lease = previous?.runtime === runtime.actor && previous.lease ? previous.lease : randomBytes(32).toString("base64url");
    const spec = RoutineSpec.parse({ routine: id, revision, schedule: routine.schedule, timezone: row.timezone, lease, template });
    this.saveRow({ ...row, runtime: runtime.actor, lease, spec: JSON.stringify(spec) });
  }

  /** 交给某个执行器的全部计划（放进 RuntimeSync.routines）。 */
  plans(actor: string): RoutineSpec[] {
    return this.store.db.query<{ spec: string }, [string]>("SELECT spec FROM routine_plans WHERE runtime=? AND spec IS NOT NULL ORDER BY routine").all(actor)
      .map((r) => RoutineSpec.parse(JSON.parse(r.spec)));
  }

  /**
   * 执行器报来一个 Hub 没见过的 Job：按编号认出是哪个例行任务的哪一次，补建记录。认不出返回 undefined。
   * 只认交给这个执行器的计划；补建的记录用当前计划的内容（执行器实际用的是它当时收到的那份）。
   */
  adopt(actor: string, id: string, now: Date): Job | undefined {
    let fired: Date;
    try { fired = new Date(idTime(id)); } catch { return undefined; }
    for (const spec of this.plans(actor)) {
      if (routineJobId(spec.routine, fired) !== id) continue;
      const job = Job.parse({
        spec: { protocol_version: JOB_PROTOCOL_VERSION, id, source: { routine: spec.routine, round: 1, fired_at: fired.toISOString() },
          runtime: actor, lease: spec.lease, run: spec.template.run, workdir: spec.template.workdir,
          ...(spec.template.gpus ? { gpus: spec.template.gpus } : {}), timeout_seconds: spec.template.timeout_seconds, created: fired.toISOString() },
        status: "assigned", assigned: now.toISOString(),
      });
      this.jobs.record(job);
      this.store.db.query("INSERT OR IGNORE INTO routine_runs(job, routine, fired_at) VALUES (?, ?, ?)").run(id, spec.routine, fired.toISOString());
      return job;
    }
    return undefined;
  }

  private runs(routine: string): { fired_at: string; job: Job; written: number }[] {
    return this.store.db.query<{ job: string; fired_at: string; written: number }, [string]>(
      "SELECT job, fired_at, written FROM routine_runs WHERE routine=? ORDER BY fired_at").all(routine)
      .flatMap((r) => { try { return [{ fired_at: r.fired_at, written: r.written, job: this.jobs.get(r.job) }]; } catch { return []; } });
  }

  /** 把有了结果、还没写回的那几次按触发时间追加到例行任务笔记。 */
  async writeResults(): Promise<void> {
    const pending = this.store.db.query<{ job: string; routine: string; fired_at: string }, []>(
      "SELECT job, routine, fired_at FROM routine_runs WHERE written=0 ORDER BY fired_at").all();
    for (const run of pending) {
      let job: Job;
      try { job = this.jobs.get(run.job); } catch { continue; }
      if (!job.result && job.status !== "cancelled") continue;
      const row = this.row(run.routine);
      if (!row) { this.markWritten(run.job); continue; }
      const block = this.render(row, run.fired_at, job);
      const name = `run-${localTime(run.fired_at, row.timezone).replace(/[-: ]/g, "").replace(/^(\d{8})/, "$1-")}`;
      try {
        await editNote(this.config.vault, row.path, (b) => upsertBlock(b, name, `job=${job.spec.id}`, block),
          { message: `lumio: ${row.title} ${localTime(run.fired_at, row.timezone)} 的结果 ${job.status}`, trailers: { "Lumio-Actor": job.spec.runtime, "Lumio-Job": job.spec.id } },
          () => this.issue(row.path, `跳过  ${row.path}  Hub 的写入已完成，但未能单独提交，将由自动保存提交`));
      } catch {
        this.issue(row.path, `跳过  ${row.path}  无法写回 ${localTime(run.fired_at, row.timezone)} 的结果`);
        continue;
      }
      this.markWritten(run.job);
      // 结果写回后计划可能要变（context: previous 时带上这一次的摘要）。不依赖文件监听，直接重算。
      await this.noteChanged(row.path);
    }
  }
  private markWritten(job: string) { this.store.db.query("UPDATE routine_runs SET written=1 WHERE job=?").run(job); }

  private render(row: PlanRow, firedAt: string, job: Job): string {
    const r = job.result;
    const status = r?.status ?? "cancelled";
    const outcome = status === "done" ? "" : ` · ${status === "failed" ? `失败：${r?.error ?? (r?.exit_code !== undefined ? `退出码 ${r.exit_code}` : "未知原因")}` : OUTCOME[status] ?? status}`;
    const runtime = this.store.runtimes(new Date(this.clock.now())).find((x) => x.actor === job.spec.runtime)?.registration.name ?? job.spec.runtime;
    const engine = r?.engine ? `${r.engine.name} ${r.engine.version} · ${r.engine.sandbox === "os" ? "系统沙箱" : "无沙箱"}` : job.spec.run.kind === "agent" ? job.spec.run.engine : "command";
    const lines = [`### ${localTime(firedAt, row.timezone)} 的结果${outcome}`, "", `（${engine} · ${runtime}）`, ""];
    // 执行器离线期间错过的触发：只补跑了最近一次，其余记为跳过（P2-5）。
    const earlier = this.store.db.query<{ fired_at: string }, [string, string]>(
      "SELECT max(fired_at) AS fired_at FROM routine_runs WHERE routine=? AND fired_at<?").get(row.routine, firedAt)?.fired_at;
    if (earlier) {
      try {
        const skipped = dueFires(parseCron(row.schedule), row.timezone, new Date(earlier), new Date(Date.parse(firedAt) - 1)).count;
        if (skipped > 0) lines.push(`> 上一次之后有 ${skipped} 次计划触发没有执行（执行器离线或例行任务暂停），已跳过。`, "");
      } catch { /* schedule 已改得无法解析：不统计 */ }
    }
    const report = r?.report ?? "", question = r?.question;
    if (containsSecret(report) || (question && containsSecret(question))) {
      lines.push(`汇报中疑似包含敏感信息（密钥或卡号），未写入笔记。请用 \`lumio job show ${job.spec.id}\` 查看。`);
    } else {
      if (report) lines.push(report.length > MAX_SUMMARY ? `${report.slice(0, MAX_SUMMARY)}\n\n……（已截断）` : report, "");
      if (question) lines.push(`> **问题**：${question}`, "");
    }
    lines.push(`完整汇报：\`lumio job show ${job.spec.id}\``);
    return lines.join("\n");
  }

  /** `GET /v1/routines`。 */
  list(): RoutineInfo[] {
    const now = new Date(this.clock.now());
    const names = new Map(this.store.runtimes(now).map((r) => [r.actor, r.registration.name]));
    return this.rows().map((row) => {
      let next: string | undefined;
      if (row.status === "active" && row.spec) { try { next = nextFire(parseCron(row.schedule), row.timezone, now)?.toISOString(); } catch { /* 无 */ } }
      const last = this.runs(row.routine).at(-1);
      return RoutineInfo.parse({
        routine: { id: row.routine, type: "routine", title: row.title, path: row.path }, schedule: row.schedule, timezone: row.timezone,
        status: row.status, ...(row.spec && row.runtime && names.get(row.runtime) ? { runtime: names.get(row.runtime) } : {}),
        ...(next ? { next } : {}), ...(last ? { last: { job: last.job.spec.id, fired_at: last.fired_at, status: last.job.status } } : {}),
        ...(row.problem ? { problem: row.problem } : {}),
      });
    });
  }

  /**
   * `routine.followup`：从某一次结果开出一个普通任务（ADR 0019 第 6 节）。调用方已授权、在写入队列里执行。
   * 负责人与执行配置照抄例行任务；`turn: human`，等人写下追问后再派出。那一次的汇报放在一个 AI 区块里，第 1 轮派出时附上。
   */
  async followup(routineId: string, jobId: string, identity: Identity): Promise<NoteRef> {
    let job: Job;
    try { job = this.jobs.get(jobId); } catch { throw new HubError("NOT_FOUND", "找不到这一次的记录"); }
    if (job.spec.source?.routine !== routineId || !job.spec.source.fired_at) throw new HubError("INVALID", "这个 Job 不是该例行任务的某一次");
    let path = this.row(routineId)?.path;
    if (!path) {
      try { path = (await showNote(this.config.vault, routineId, { stateDir: this.config.stateDir })).note.path; }
      catch { throw new HubError("NOT_FOUND", "找不到这个例行任务"); }
    }
    const parsed = Routine.safeParse(parseFrontmatter(await readFile(join(this.config.vault, path))).data);
    if (!parsed.success) throw new HubError("INVALID", "例行任务格式不对，无法照抄负责人与执行配置");
    const routine = parsed.data;
    const zone = routine.timezone ?? this.defaultZone;
    const when = localTime(job.spec.source.fired_at, zone);
    const now = new Date(this.clock.now());
    const id = newId("task", now, randomBytes);
    const title = `${routine.title} · ${when} 追问`;
    const fields: Record<string, unknown> = {
      id, type: "task", title, created: now.toISOString(), updated: now.toISOString(), status: "todo", turn: "human",
      assignee: { agent: routine.assignee.agent, ...(routine.assignee.device ? { device: routine.assignee.device } : {}) },
      ...(routine.workdir ? { workdir: routine.workdir } : {}), ...(routine.model ? { model: routine.model } : {}),
      ...(routine.gpus ? { gpus: routine.gpus } : {}), ...(routine.timeout_minutes ? { timeout_minutes: routine.timeout_minutes } : {}),
      ...(routine.project ? { project: routine.project } : {}), routine: routineId,
    };
    // JSON 的字符串、数组与对象都是合法的 YAML 流式写法，不必引入 YAML 序列化的细节。
    const header = Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === "string" && /^[A-Za-z0-9_.:+-]+$/.test(v) ? v : JSON.stringify(v)}`).join("\n");
    const report = job.result?.report ?? "";
    const shown = containsSecret(report) ? `汇报中疑似包含敏感信息，未写入笔记。请用 \`lumio job show ${job.spec.id}\` 查看。`
      : report ? (report.length > 20_000 ? `${report.slice(0, 20_000)}\n\n……（已截断）` : report) : "（这一次没有汇报）";
    const body = `来自例行任务 [[${basename(path, ".md")}]] 在 ${when} 的结果。在这里写下你的追问，然后把 \`turn\` 改成 \`agent\`。\n\n`;
    let bytes: Buffer = Buffer.from(`---\n${header}\n---\n${body}`, "utf8");
    bytes = upsertBlock(bytes, "routine-run", `job=${job.spec.id}`, `### ${when} 的结果\n\n${shown}`);
    const dir = entityDirectory("task");
    const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, "-");
    let relativePath = `${dir}/${safe}.md`;
    for (let n = 2; await Bun.file(join(this.config.vault, relativePath)).exists(); n++) relativePath = `${dir}/${safe} ${n}.md`;
    const committed = await writeAndCommit(this.config.vault, relativePath, Buffer.alloc(0),
      async () => { await mkdir(join(this.config.vault, dir), { recursive: true }); await writeFileAtomic(join(this.config.vault, relativePath), bytes, { overwrite: false }); },
      `lumio: routine.followup ${title}`, { "Lumio-Actor": identity.actor.id, "Lumio-Job": job.spec.id });
    if (!committed) this.issue(relativePath, `跳过  ${relativePath}  Hub 的写入已完成，但未能单独提交，将由自动保存提交`);
    return NoteRef.parse({ id, type: "task", title, path: relativePath });
  }
}
