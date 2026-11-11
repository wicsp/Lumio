import { createHash, randomBytes } from "node:crypto";
import { newId } from "@lumio/foundation";
import {
  Job, Notice, NoticeCommand, NoticeCommandResult, NoticeList, NoticeListArgs, ResourceRef, WatchdogFinding, WorkTaskDetail,
  type Capture, type Proposal, type WorkTask,
} from "@lumio/schema";
import { WorkError } from "@lumio/work";
import type { AssistantMainConversations } from "./assistant-main.ts";
import type { Capabilities } from "./capabilities.ts";
import type { DecisionGate, NoticeDecisionInput } from "./decision-gate.ts";
import { HubError } from "./errors.ts";
import { text as msg } from "./messages.ts";
import type { Notifications } from "./notifications.ts";
import type { Resources } from "./resources.ts";
import type { HubStore, Identity } from "./store.ts";
import { containsSecret } from "./tasks.ts";
import type { WorkCommands } from "./work-commands.ts";

export const NOTICE_ROUTES = [
  { operation: "notices.read", method: "GET", pattern: /^\/v2\/notices$/, path: "/v2/notices" },
  { operation: "notices.command", method: "POST", pattern: /^\/v2\/notices\/commands$/, path: "/v2/notices/commands" },
] as const;

type Status = NoticeDecisionInput["structured_summary"]["status"];
type Source = { event: string; created: string; owners: string[] } & (
  | { kind: "turn"; job: string; task?: string; alreadyPushed: boolean }
  | { kind: "proposal"; proposal: string; task?: string }
  | { kind: "capture"; entity?: string }
  | { kind: "watchdog"; findings: WatchdogFinding[] }
  | { kind: "exploration"; exploration: string; target: string; status: "found" | "nothing" | "stopped"; note?: string; summary?: string }
);
type Details = Pick<Notice, "title" | "subject" | "summary" | "findings" | "ai_note"> & {
  status: Status;
  task?: WorkTaskDetail;
  path: string;
  required: boolean;
};
type Grade = Pick<Notice, "level" | "graded">;
type Prepared = { source: Source; details: Details | undefined; grades: Grade[] };
type Row = { record: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new HubError("INVALID", { key: "notices.invalid", args: [] });
const ref = (module: ResourceRef["module"], id: string) => ResourceRef.parse({ module, id });
const roundStatus = (status: Job["status"]): Status | undefined => {
  if (status === "done") return "delivered";
  if (status === "waiting_for_human") return "waiting_for_human";
  if (status === "failed" || status === "unknown") return "failed";
};
function excerpt(text: string | undefined, limit: number): string | undefined {
  if (!text?.trim() || containsSecret(text)) return;
  const clipped = text.trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
  return clipped || undefined;
}

function inaccessible(cause: unknown): boolean {
  return (cause instanceof WorkError || cause instanceof HubError) && (cause.code === "NOT_FOUND" || cause.code === "FORBIDDEN");
}

interface NoticeModules {
  assistantMain: Pick<AssistantMainConversations, "mainConversation">;
  capabilities: Capabilities;
  resources: Resources;
  workCommands: WorkCommands;
  decisionGate: Pick<DecisionGate, "gradeNotice">;
  notifications: Notifications;
}

/** Receives committed Hub events and materializes per-owner notices outside the producing request. */
export class Notices {
  private worker?: Promise<void>;
  private prepared?: Prepared[];
  private activeChats = 0;
  constructor(private readonly hub: HubStore, private readonly modules: NoticeModules,
    private readonly now: () => Date, private readonly signal: AbortSignal) {
    hub.db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_notice_sources (
        event TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(json_valid(source)), done INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS workbench_notice_pending ON workbench_notice_sources(done) WHERE done=0;
      CREATE TABLE IF NOT EXISTS workbench_notices (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES actors(id), event TEXT NOT NULL,
        level TEXT NOT NULL, created TEXT NOT NULL, read_at TEXT, announced INTEGER NOT NULL DEFAULT 0,
        record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(owner,event)
      );
      CREATE INDEX IF NOT EXISTS workbench_notice_owner ON workbench_notices(owner,created DESC,id DESC);
      CREATE TABLE IF NOT EXISTS workbench_notice_requests (
        owner TEXT NOT NULL REFERENCES actors(id), request TEXT NOT NULL, fingerprint TEXT NOT NULL,
        result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(owner,request)
      );
    `);
  }

  private humans(): string[] {
    return this.hub.actors().filter(actor => actor.role === "human").map(actor => actor.id);
  }

  private enqueue(source: Source): void {
    if (!source.owners.length) return;
    this.hub.db.query("INSERT OR IGNORE INTO workbench_notice_sources(event,source) VALUES(?,?)")
      .run(source.event, JSON.stringify(source));
  }

  round(job: Job, task?: string, alreadyPushed = false): void {
    if (!job.result || !roundStatus(job.result.status)) return;
    this.enqueue({ kind: "turn", event: "turn:" + job.spec.id, job: job.spec.id, task, alreadyPushed,
      owners: this.humans(), created: job.result.finished });
  }

  proposal(proposal: Proposal, task?: string): void {
    this.enqueue({ kind: "proposal", event: "proposal:" + proposal.id, proposal: proposal.id, task,
      owners: this.humans(), created: proposal.created });
  }

  capture(capture: Capture): void {
    if (capture.state !== "ready") return;
    this.enqueue({ kind: "capture", event: "capture:" + capture.id, entity: capture.entity?.id,
      owners: [capture.owner], created: capture.updated });
  }

  watchdog(event: string, findings: WatchdogFinding[]): void {
    const subjects = WatchdogFinding.array().max(50).parse(findings).map(finding => ({
      ...finding, subject: ref(finding.subject.module, finding.subject.id),
    }));
    this.enqueue({ kind: "watchdog", event: "watchdog:" + digest(event), findings: subjects,
      owners: this.humans(), created: this.now().toISOString() });
  }

  /** 提前探索结束（ADR 0059 第 5 节，A1-9）。有发现才交给闸门定级别，其余静默记录。 */
  exploration(input: { owner: string; exploration: string; target: string; status: "found" | "nothing" | "stopped"; note?: string; summary?: string; created: string }): void {
    const { owner, created, ...rest } = input;
    this.enqueue({ kind: "exploration", event: "exploration:" + input.exploration, owners: [owner], created, ...rest });
  }

  /** No pre-read comment or new notice can be published while a main turn reads Work. */
  async duringChat<T>(chat: () => Promise<T>): Promise<T> {
    this.activeChats++;
    try { return await chat(); }
    finally { this.activeChats--; }
  }

  drain(): Promise<void> {
    if (this.signal.aborted || (this.activeChats && this.prepared)) return Promise.resolve();
    this.worker ??= this.flush().finally(() => { this.worker = undefined; });
    return this.worker;
  }

  async stop(): Promise<void> {
    await this.worker?.catch(() => {});
  }

  private async task(id: string, identity: Identity): Promise<WorkTaskDetail | undefined> {
    try {
      const { result } = await this.modules.capabilities.execute("work.task.show", { task: id }, identity);
      return WorkTaskDetail.parse(result);
    } catch (cause) { if (!inaccessible(cause)) throw cause; }
  }

  private async details(source: Source, identity: Identity): Promise<Details | undefined> {
    switch (source.kind) {
      case "turn": {
        try {
          const { result } = await this.modules.capabilities.execute("execution.job.show", { job: source.job }, identity);
          const job = Job.parse(result), status = job.result && roundStatus(job.result.status);
          if (!job.result || !status) return;
          const task = source.task ? await this.task(source.task, identity) : undefined;
          if (source.task && !task) return;
          const title = excerpt(task?.task.title, 120) ?? msg("notices.round");
          const summary = excerpt(job.result.question ?? job.result.report ?? job.result.error, 1500);
          return { title, summary, status, task, required: source.alreadyPushed,
            subject: task ? ref("work", task.task.id) : ref("execution", job.spec.id),
            path: task ? "#work/" + task.task.id : "#execution" };
        } catch (cause) { if (!inaccessible(cause)) throw cause; return; }
      }
      case "proposal": {
        if (this.hub.proposal(source.proposal)?.status !== "pending") return;
        const task = source.task ? await this.task(source.task, identity) : undefined;
        return { title: excerpt(task?.task.title, 120) ?? msg("notices.proposal"), status: "pending", required: true,
          subject: task && ref("work", task.task.id), path: "#approvals" };
      }
      case "capture": {
        const entity = source.entity && await this.modules.resources.resolve(source.entity, identity);
        if (!entity || entity.status !== "visible") return;
        return { title: excerpt(entity.title, 120) ?? msg("notices.capture"), status: "ready", required: false,
          subject: ref("knowledge", entity.id), path: "#inbox" };
      }
      case "exploration": {
        const target = await this.modules.resources.resolve(source.target, identity);
        if (target.status !== "visible") return;
        return { title: msg("notices.exploration") + " · " + (excerpt(target.title, 100) ?? source.target), status: source.status, required: false,
          summary: excerpt(source.summary, 600), ai_note: source.note,
          subject: source.note ? ref("knowledge", source.note) : ref(target.id.startsWith("idea_") ? "knowledge" : "work", target.id),
          path: source.note ? "#knowledge/" + source.note : "#overview" };
      }
      case "watchdog": {
        const findings = [];
        for (const finding of source.findings) {
          if ((await this.modules.resources.resolve(finding.subject.id, identity)).status === "visible") {
            findings.push({ ...finding, subject: ref(finding.subject.module, finding.subject.id) });
          }
        }
        if (!findings.length) return;
        return { title: msg("notices.watchdog"), status: "report", required: false, findings,
          subject: findings.length === 1 ? findings[0]!.subject : undefined, path: "#overview" };
      }
    }
  }

  private grade(owner: string, source: Source, details: Details): Promise<Grade> {
    if (details.required) return Promise.resolve({ level: "important", graded: { by: "rule" } });
    // 探索没有发现或用完预算：记一句即可，不打扰人（ADR 0059 第 5 节）。
    if (source.kind === "exploration" && source.status !== "found") return Promise.resolve({ level: "silent", graded: { by: "rule" } });
    const due = details.task?.task.due;
    return this.modules.decisionGate.gradeNotice(owner, {
      source: "hub", visibility: "public", event_kind: source.kind,
      // A captured title comes from the source document. Never send it or the pre-read excerpt to Jev.
      subject_title: details.task ? excerpt(details.task.task.title, 120)?.replace(/\s+/gu, " ") : undefined,
      structured_summary: { status: details.status, count: details.findings?.length,
        dependent_tasks: details.task?.dependents.length,
        days_until_due: due === undefined ? undefined : Math.ceil((Date.parse(due) - this.now().getTime()) / 86_400_000) },
    });
  }

  private async flush(): Promise<void> {
    // Bound the amount of work drained after a chat ends.
    const rows = this.prepared ? [] : this.hub.db.query<{ source: string }, []>(
      "SELECT source FROM workbench_notice_sources WHERE done=0 ORDER BY rowid LIMIT 8",
    ).all();
    if (!this.prepared && !rows.length) return;
    const reader = { actor: this.hub.assistantActor(), label: "assistant-pre-read" };
    // Keep the results if a main request starts while the gate is still responding.
    this.prepared ??= await Promise.all(rows.map(async row => {
      const source = JSON.parse(row.source) as Source;
      const details = await this.details(source, reader);
      const grades = details ? await Promise.all(source.owners.map(owner => this.grade(owner, source, details))) : [];
      return { source, details, grades };
    }));
    for (const { source, details, grades } of this.prepared) {
      if (this.activeChats || this.signal.aborted) return;
      const visible = details?.subject && (await this.modules.resources.resolve(details.subject.id, reader)).status === "visible";
      if (this.activeChats || this.signal.aborted) return;
      this.hub.db.transaction(() => {
        const claimed = this.hub.db.query("UPDATE workbench_notice_sources SET done=1 WHERE event=? AND done=0").run(source.event);
        if (!claimed.changes || !details || (details.subject && !visible) ||
            (source.kind === "proposal" && this.hub.proposal(source.proposal)?.status !== "pending")) return;
        const comment = this.comment(source, details, reader);
        for (const [index, owner] of source.owners.entries()) {
          const grade = grades[index]!;
          const notice = Notice.parse({
            id: newId("ntc", this.now(), randomBytes), owner, source: source.kind, event: source.event, ...grade,
            subject: details.subject, title: details.title, summary: details.summary, comment, ai_note: details.ai_note,
            findings: details.findings, created: source.created,
          });
          this.hub.db.query("INSERT INTO workbench_notices(id,owner,event,level,created,record) VALUES(?,?,?,?,?,?)")
            .run(notice.id, owner, notice.event, notice.level, notice.created, JSON.stringify(notice));
          if (notice.level === "important" && !details.required) {
            this.modules.notifications.notifyWorkbench({
              id: digest(source.event + ":" + owner), owner, title: msg("notices.important"), path: details.path, created: notice.created,
            });
          }
        }
      }).immediate();
    }
    this.prepared = undefined;
  }

  private comment(source: Source, details: Details, identity: Identity): string | undefined {
    // Materialize assistant discussion for the workbench. Work keeps the original round report for every client.
    if (source.kind !== "turn" || !details.task ||
        !source.owners.some(owner => this.modules.assistantMain.mainConversation(owner))) return;
    try {
      const result = this.modules.workCommands.execute({
        request_id: "pre-read:" + digest(source.event),
        operation: { op: "work.task.comment", args: {
          task: details.task.task.id,
          body: [msg("notices.pre_read", details.status, source.job), details.summary].filter(Boolean).join("\n\n"),
        } },
      }, identity);
      if (result.kind === "comment") return result.comment.id;
    } catch (cause) {
      if (!inaccessible(cause)) throw cause;
      this.hub.audit(identity, "work.task.comment", "deny", undefined, "pre-read");
    }
  }

  list(owner: string, args: NoticeListArgs): NoticeList {
    const { unread, level, limit } = NoticeListArgs.parse(args);
    const rows = this.hub.db.query<Row, [string, string | null, string | null, number | null, number | null, number]>(`
      SELECT record FROM workbench_notices WHERE owner=?
      AND ((? IS NULL AND level<>'silent') OR level=?)
      AND (? IS NULL OR (read_at IS NULL)=?)
      ORDER BY created DESC,id DESC LIMIT ?
    `).all(owner, level ?? null, level ?? null, unread === undefined ? null : Number(unread), unread === undefined ? null : Number(unread), limit);
    const count = this.hub.db.query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM workbench_notices WHERE owner=? AND level<>'silent' AND read_at IS NULL",
    ).get(owner)!.count;
    return NoticeList.parse({ notices: rows.map(row => JSON.parse(row.record)), unread: count });
  }

  private markRead(identity: Identity, input: NoticeCommand): NoticeCommandResult {
    const owner = identity.actor.id, fingerprint = digest(JSON.stringify(input.notices));
    return this.hub.db.transaction(() => {
      const previous = this.hub.db.query<{ fingerprint: string; result: string }, [string, string]>(
        "SELECT fingerprint,result FROM workbench_notice_requests WHERE owner=? AND request=?",
      ).get(owner, input.request_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new HubError("CONFLICT", { key: "index.request_id_was_used_for_a_different_operation", args: [] });
        return NoticeCommandResult.parse(JSON.parse(previous.result));
      }
      const updated = [];
      const read = this.now().toISOString();
      for (const id of new Set(input.notices)) {
        const change = this.hub.db.query(`
          UPDATE workbench_notices SET read_at=?, record=json_set(record,'$.read',?)
          WHERE owner=? AND id=? AND read_at IS NULL
        `).run(read, read, owner, id);
        if (change.changes) updated.push(id);
      }
      const result = NoticeCommandResult.parse({ updated });
      this.hub.db.query("INSERT INTO workbench_notice_requests VALUES(?,?,?,?)").run(owner, input.request_id, fingerprint, JSON.stringify(result));
      this.hub.audit(identity, "notices.command", "allow", undefined, "applied");
      return result;
    }).immediate();
  }

  async handle(request: Request, operation: typeof NOTICE_ROUTES[number]["operation"], identity: Identity): Promise<Response> {
    if (identity.actor.role !== "human") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
    const respond = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "no-store" } });
    if (operation === "notices.command") {
      const input = NoticeCommand.safeParse(await request.json().catch(() => undefined));
      if (!input.success) throw invalid();
      return respond(this.markRead(identity, input.data));
    }
    const params = new URL(request.url).searchParams;
    const unread = params.get("unread"), limit = params.get("limit");
    const input = NoticeListArgs.safeParse({
      unread: unread === "true" ? true : unread === "false" ? false : unread ?? undefined,
      level: params.get("level") ?? undefined,
      limit: limit === null ? undefined : /^\d+$/.test(limit) ? Number(limit) : NaN,
    });
    if (!input.success) throw invalid();
    return respond(this.list(identity.actor.id, input.data));
  }

  announce(owner: string, send: (notice: Notice) => void): void {
    for (const row of this.hub.db.query<Row, [string]>(`
      SELECT record FROM workbench_notices WHERE owner=? AND level='important' AND read_at IS NULL AND announced=0
      ORDER BY created,id LIMIT 20
    `).all(owner)) {
      const notice = Notice.parse(JSON.parse(row.record));
      send(notice);
      this.hub.db.query("UPDATE workbench_notices SET announced=1 WHERE id=?").run(notice.id);
    }
  }

  forModel(owner: string) {
    return this.list(owner, { unread: true, limit: 20 }).notices.flatMap(notice =>
      notice.subject ? [{ ref: notice.subject, summary: notice.summary ?? notice.title }] : []);
  }
}
