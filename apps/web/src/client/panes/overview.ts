/**
 * 今日：先是需要你处理的事（轮到你回答 / 验收 / 处理失败、待批准），再是你的待办，
 * 然后是 agent 在做的和在等外部的（ADR 0032）；旁边是 agent 动态与项目进度。
 * 各区块独立加载失败；不在这里放统计大字。
 */
import type { Job, JobAttention, Notice, Proposal, WorkAttention, WorkProject, WorkTask } from "@lumio/schema";
import { openResource } from "../resources.ts";
import { noticePreview, noticeTitle } from "../workbench-assist.ts";
import { errorText, type Client, type HubExtras } from "../api.ts";
import { executionGroups } from "../execution-groups.ts";
import { attentionCard } from "../attention-card.ts";
import { formatTime, newRequestId } from "../commands.ts";
import { quickDelegateActions } from "../delegate.ts";
import { clear, failure, h, icon, loading, openMenu, statusIcon, toast } from "../dom.ts";
import { ago, dueLabel, jobTitle } from "../format.ts";
import { JOB_LABELS } from "../labels.ts";
import type { Navigate } from "../navigation.ts";
import { taskTurnMenu } from "../turn-menu.ts";
import { locale, t } from "../i18n.ts";
import { turnGroup, turnIcon, turnText } from "../turn.ts";
import { isWorkProposal, proposalCard } from "../proposal-card.ts";
import { jobActivityBadge } from "../job-activity.ts";
import { personalSchedule } from "./personal.ts";
import { LiveData, settled, type LiveSnapshot } from "../live-data.ts";

const LIVE = ["queued", "assigned", "running"];
const DAY = 86_400_000;

/** Show one current round per task, even when a plan is running in parallel. */
export function todayAgentRuns(jobs: readonly Job[], tasks: readonly WorkTask[]): Job[] {
  const turns = new Map(tasks.map(task => [task.id, task.turn]));
  const candidates = jobs.filter(job => {
    const task = job.spec.source?.task;
    if (!task) return true;
    const turn = turns.get(task);
    if (!turn) return LIVE.includes(job.status);
    return turn.job === job.spec.id || turn.parallel?.some(branch => branch.job === job.spec.id);
  });

  candidates.sort((a, b) => Number(LIVE.includes(b.status)) - Number(LIVE.includes(a.status))
    || Date.parse(b.spec.created) - Date.parse(a.spec.created));
  const seen = new Set<string>();
  return candidates.filter(job => {
    const key = job.spec.source?.task ?? job.spec.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class OverviewPane {
  private body = h("div", { class: "today-inner" });
  private generation = 0;
  private active = true;
  /** 上一次渲染所用数据的指纹：数据没变就不重画，保留展开的汇报、焦点与滚动位置。 */
  private signature = "";
  /** 「需要你处理」里展开了完整汇报的卡片（按轮次），刷新后保持展开。 */
  private expanded = new Set<string>();
  private live: LiveData;

  constructor(owner: HTMLElement, private client: Client, private hub: HubExtras, private navigate: Navigate, private name: string, private changed: () => void = () => {}, live?: LiveData) {
    this.live = live ?? new LiveData(client, hub);
    owner.append(h("div", { class: "today" }, this.body));
    clear(this.body, this.header(), loading(t("Gathering today's work…")));
    void this.load();
  }
  dispose(): void { this.active = false; this.generation++; }
  /** 静默刷新；卡片里正在输入、正在提交或焦点在输入框里时不打断。 */
  liveRefresh(): void {
    const typing = [...this.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")].some(el => el.value.trim());
    const active = document.activeElement;
    if (typing || this.body.querySelector(".is-busy") || (active && this.body.contains(active) && active.matches("input, textarea, select"))) return;
    void this.load(2000);
  }

  private header(summary?: string): HTMLElement {
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 5 ? t("Good evening, {0}", this.name) : hour < 12 ? t("Good morning, {0}", this.name) : hour < 18 ? t("Good afternoon, {0}", this.name) : t("Good evening, {0}", this.name);
    const date = new Intl.DateTimeFormat(locale(), { month: "long", day: "numeric", weekday: "long" }).format(now);
    return h("header", { class: "today-head" },
      h("div", { class: "today-head-text" },
        h("p", { class: "today-date" }, date),
        h("h1", { class: "today-greeting" }, greeting),
        summary && h("p", { class: "today-summary" }, summary)),
      h("button", { type: "button", class: "avatar-btn mobile-flex", title: t("Settings"), "aria-label": t("Settings"), onclick: () => this.navigate("settings") },
        this.name.slice(0, 1).toUpperCase()));
  }

  /** maxAge：可以复用多新的共用快照（毫秒）；操作之后传 0 强制重读。 */
  private async load(maxAge = 0): Promise<void> {
    const generation = ++this.generation;
    const [snapshot, projects, personal] = await Promise.all([
      this.live.get(maxAge),
      Promise.allSettled([this.client.workProjects()]).then(([value]) => value),
      this.hub.personalView?.().catch(() => undefined),
    ]);
    if (!this.active || generation !== this.generation) return;
    const signature = JSON.stringify([snapshotKey(snapshot), projects, personal?.events, personal?.todos, personal?.sync_ok, new Date().toDateString()]);
    if (signature === this.signature) return;
    this.signature = signature;
    const { tasks, jobs, proposals: approvals, attention, notices, jobAttention: liveAttention } = snapshot;
    const taskData = settled(tasks);
    const projectData = settled(projects) ?? [];
    const jobData = settled(jobs);
    const approvalData = settled(approvals);

    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + DAY;
    const mine = taskData?.filter(task => turnGroup(task) === "todo") ?? [];
    const dueSoon = (task: WorkTask) => !!task.due && new Date(task.due).getTime() < endOfToday;
    // 今天：今天到期或已逾期的待办；没有的话，最近交回给你的排在前面。
    const focus = mine.filter(dueSoon).sort(byFocus);
    const next = mine.filter(task => !focus.includes(task)).sort(byDue);
    const agentsWorking = taskData?.filter(task => turnGroup(task) === "agents") ?? [];
    const waiting = taskData?.filter(task => turnGroup(task) === "external") ?? [];
    const activity = todayAgentRuns(jobData ?? [], taskData ?? []);
    const running = activity.filter(job => LIVE.includes(job.status));
    // ADR 0032：任务提醒按当前交接；旧 Hub 与独立运行使用同一套回退规则。
    const attentionData = settled(attention);
    const liveRequests = settled(liveAttention) ?? [];
    const needCount = needsYouCount(snapshot);
    const parts = taskData ? [
      needCount ? t(needCount === 1 ? "{0} needs you" : "{0} need you", needCount) : "",
      t(mine.length === 1 ? "{0} to-do" : "{0} to-dos", mine.length),
      agentsWorking.length ? t(agentsWorking.length === 1 ? "{0} task with agents" : "{0} tasks with agents", agentsWorking.length) : "",
    ].filter(Boolean) : [];

    const personalToday = personal ? new Intl.DateTimeFormat("sv-SE", { timeZone: personal.timezone, dateStyle: "short" }).format(now) : "";
    const dateOf = (value: string, zone: string) =>
      new Intl.DateTimeFormat("sv-SE", { timeZone: zone, dateStyle: "short" }).format(new Date(value));
    const personalEvents = personal?.events.filter(({ schedule }) => schedule.kind === "all_day"
      ? schedule.start <= personalToday && personalToday < schedule.end
      : dateOf(schedule.start, personal.timezone) <= personalToday && personalToday <= dateOf(new Date(Date.parse(schedule.end) - 1).toISOString(), personal.timezone)) ?? [];
    const personalTodos = personal?.todos.filter(todo => todo.status === "open" && (!todo.due ||
      (todo.due.kind === "date" ? todo.due.date : dateOf(todo.due.at, personal.timezone)) <= personalToday)) ?? [];
    clear(this.body,
      this.header(parts.join(t(" · "))),
      this.ask(),
      h("div", { class: "today-grid" },
        h("div", { class: "today-col" },
          this.needsYou(approvalData, attentionJobs(snapshot), approvals.status === "rejected" ? approvals.reason : undefined, taskData ?? [], attentionData ?? [], liveRequests),
          notices.status === "fulfilled" ? this.pending(pendingNotices(notices.value)) : null,
          focus.length || tasks.status === "rejected" ? this.section("due", t("Due today"), focus.length, () => this.navigate("work", "tasks"),
            tasks.status === "rejected" ? failure(errorText(tasks.reason)) : this.taskList(focus, projectData, "")) : null,
          tasks.status === "fulfilled" ? this.section("todo", focus.length ? t("Your other to-dos") : t("Your to-dos"), next.length, () => this.navigate("work", "tasks"), this.taskList(next.slice(0, 6), projectData, focus.length ? t("Nothing else on your list.") : t("Your to-do list is clear."))) : null,
          agentsWorking.length ? this.section("active", t("Agents working"), agentsWorking.length, () => this.navigate("work", "tasks"), this.taskList(agentsWorking, projectData, "")) : null,
          waiting.length ? this.section("waiting", t("Waiting on others"), waiting.length, () => this.navigate("work", "tasks"), this.taskList(waiting, projectData, "")) : null),
        h("div", { class: "today-col today-side" },
          personal ? this.section("personal", t("Personal"), personalEvents.length + personalTodos.length, () => this.navigate("personal"),
            h("div", { class: "today-personal", "data-private-personal": "true" },
              !personal.sync_ok ? h("p", { class: "today-empty" }, t("Calendar sync is pending or unavailable.")) : null,
              ...personalEvents.slice(0, 5).map(item => h("div", { class: "today-row" }, icon("calendar"),
                h("span", { class: "row-main" }, item.title, h("span", { class: "row-sub" }, personalSchedule(item.schedule))))),
              ...personalTodos.slice(0, 5).map(item => h("div", { class: "today-row" }, statusIcon("todo"), h("span", { class: "row-main" }, item.title))),
              personal.sync_ok && !personalEvents.length && !personalTodos.length
                ? h("p", { class: "today-empty" }, t("No personal events or to-dos due today.")) : null)) : null,
          this.section("runs", t("Agent activity"), running.length, () => this.navigate("execution"),
            jobs.status === "rejected" ? failure(errorText(jobs.reason)) : this.runs(activity, taskData ?? [])),
          this.section("projects", t("Projects"), projectData.filter(p => p.status !== "done").length, () => this.navigate("work", "projects"),
            projects.status === "rejected" ? failure(errorText(projects.reason)) : this.projects(projectData, taskData ?? [])))));
  }

  /** 待处理（ADR 0059 第 4 节）：后台预读与提醒里还没看的；点开对象即标为已读。 */
  private pending(notices: Notice[]): HTMLElement | null {
    if (!notices.length) return null;
    const read = async (ids: string[]) => {
      try { await this.client.readNotices(newRequestId("notice"), ids); this.changed(); void this.load(); }
      catch (cause) { toast(errorText(cause), "error"); }
    };
    const rows = h("div", { class: "today-rows" }, ...notices.map(notice => h("button", { type: "button", class: "today-row notice-row", "data-pad-row": notice.id,
      onclick: () => { void read([notice.id]); if (notice.subject) void openResource(this.client, this.navigate, notice.subject.id); } },
      icon(notice.source === "watchdog" ? "alert" : notice.source === "exploration" ? "knowledge" : "bell"),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, noticeTitle(notice)),
        notice.summary && h("span", { class: "row-sub" }, noticePreview(notice.summary))),
      h("span", { class: "row-time" }, ago(notice.created)))));
    const all = h("button", { type: "button", class: "text-btn", onclick: () => void read(notices.map(notice => notice.id)) }, t("Mark all read"));
    return h("section", { class: "today-section", "data-pad-region": "pending" },
      h("header", { class: "today-section-head" }, h("h2", {}, t("To look at")), h("span", { class: "count" }, notices.length), all),
      h("div", { class: "today-card" }, rows));
  }

  private section(region: string, title: string, count: number, all: (() => void) | undefined, body: Node | null): HTMLElement {
    return h("section", { class: "today-section", "data-pad-region": region },
      h("header", { class: "today-section-head" }, h("h2", {}, title), count ? h("span", { class: "count" }, count) : null,
        all && h("button", { type: "button", class: "text-btn", onclick: all }, t("All"))),
      h("div", { class: "today-card" }, body));
  }

  private taskList(tasks: WorkTask[], projects: WorkProject[], emptyText: string): HTMLElement {
    if (!tasks.length) return h("p", { class: "today-empty" }, emptyText);
    return h("div", { class: "today-rows" }, ...tasks.map(task => {
      const due = dueLabel(task.due);
      const project = projects.find(p => p.id === task.project)?.title;
      const row = h("button", { type: "button", class: "today-row", "data-pad-row": task.id, "data-pad-menu": true, onclick: () => this.navigate("work", task.id) },
        turnIcon(turnGroup(task)),
        h("span", { class: "row-main" }, h("span", { class: "row-title" }, task.title),
          (project || task.turn.holder !== "human") && h("span", { class: "row-sub" },
            project && h("span", { class: "project-chip" }, icon("folder"), project),
            task.turn.holder !== "human" && h("span", { class: "who-chip" }, icon(task.turn.holder === "external" ? "clock" : "bot"), turnText(task)))),
        due && h("span", { class: `due-tag${due.overdue ? " overdue" : due.soon ? " soon" : ""}` }, due.overdue ? t("Overdue · {0}", due.text) : due.text));
      const delegation = quickDelegateActions(this.client, task, this.navigate, changed => {
        if (changed) this.changed();
        return this.load();
      });
      row.addEventListener("lumio-task-menu", () => {
        const pick = delegation?.querySelector<HTMLButtonElement>(".quick-delegate-pick:not(:disabled)");
        taskTurnMenu(this.client, task, row, () => { this.changed(); void this.load(); }, () => { void this.load(); },
          pick ? [{ label: t("Delegate to someone else"), run: () => pick.click() }] : []);
      });
      return delegation ? h("div", { class: "task-action-row" }, row, delegation) : row;
    }));
  }

  private needsYou(approvals: Proposal[] | undefined, jobs: Job[], error: unknown, tasks: WorkTask[], rounds: WorkAttention[], liveRequests: JobAttention): HTMLElement | null {
    if (error) return this.section("needs", t("Needs you"), 0, undefined, failure(errorText(error)));
    // 处理完一张卡片：先让「已处理」的确认停留一会儿再重画（changed 已让共用快照作废，这次读取一定是新的）。
    const context = { client: this.client, hub: this.hub, navigate: this.navigate, expanded: this.expanded,
      changed: () => { this.changed(); setTimeout(() => void this.load(), 900); } };
    const cards = [
      ...liveRequests.map(request => this.needCard(request.job, request.kind === "approval" ? "approvals" : "help", "ochre",
        tasks.find(task => task.id === request.task)?.title ?? t("Agent run"), t("Expires at {0}", formatTime(request.expires)),
        request.kind === "approval" ? t("Waiting for your approval") : t("Agent has a question"), t("View run"),
        () => this.navigate("execution", request.job))),
      ...rounds.map(item => attentionCard(item, context, "today")),
      ...(approvals ?? []).filter(isWorkProposal).map(p => proposalCard(p, context)),
      ...(approvals ?? []).filter(p => !isWorkProposal(p)).map(p => this.needCard(p.id, "approvals", "ochre",
        p.operation.op === "exec.privileged" ? p.operation.args.argv.join(" ") : p.operation.op, p.reason, t("Approval"), t("Review"), () => this.navigate("approvals"))),
      ...jobs.map(j => j.status === "waiting_for_human"
        ? this.needCard(j.spec.id, "help", "ochre", jobTitle(j, tasks), j.result?.question ?? "", JOB_LABELS[j.status] ?? j.status, t("Answer"), () => this.navigate("execution", j.spec.id))
        : this.needCard(j.spec.id, "alert", "red", jobTitle(j, tasks), j.result?.error ?? "", JOB_LABELS[j.status] ?? j.status, t("View"), () => this.navigate("execution", j.spec.id))),
    ];
    if (!cards.length) return null;
    return h("section", { class: "today-section", "data-pad-region": "needs" },
      h("header", { class: "today-section-head" }, h("h2", {}, t("Needs you")), h("span", { class: "count attention" }, cards.length)),
      h("div", { class: "needs" }, ...cards));
  }

  private needCard(id: string, glyph: string, tone: "ochre" | "red", title: string, detail: string, kind: string, action: string, go: () => void): HTMLElement {
    return h("article", { class: `need need-${tone}`, "data-pad-row": id, tabindex: "0" },
      h("span", { class: "need-icon" }, icon(glyph)),
      h("div", { class: "need-main" },
        h("p", { class: "need-kind" }, kind),
        h("button", { type: "button", class: "need-title", onclick: go }, title),
        detail && h("p", { class: "need-detail" }, detail)),
      h("button", { type: "button", class: "btn btn-small need-action", "data-pad-action": "primary", onclick: go }, action));
  }

  private runs(jobs: Job[], tasks: WorkTask[]): HTMLElement {
    const shown = jobs.slice(0, 5);
    if (!shown.length) return h("p", { class: "today-empty" }, t("No current agent activity."));
    return h("div", { class: "today-rows" }, ...shown.map(job => h("button", { type: "button", class: "today-row", "data-pad-row": job.spec.id, onclick: () => this.navigate("execution", job.spec.id) },
      statusIcon(job.status),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, jobTitle(job, tasks)),
        h("span", { class: "row-sub" }, job.spec.run.kind === "agent" ? job.spec.run.engine : t("Command"), " · ",
          LIVE.includes(job.status) ? jobActivityBadge(this.client, job.spec.id, JOB_LABELS[job.status] ?? job.status) : JOB_LABELS[job.status] ?? job.status)),
      h("span", { class: "row-time", title: formatTime(job.spec.created) }, ago(job.spec.created)))));
  }

  private projects(projects: WorkProject[], tasks: WorkTask[]): HTMLElement {
    const open = projects.filter(p => p.status !== "done").slice(0, 5);
    if (!open.length) return h("p", { class: "today-empty" }, t("No active projects."));
    return h("div", { class: "today-rows" }, ...open.map(project => {
      const related = tasks.filter(task => task.project === project.id && task.outcome !== "cancelled");
      const done = related.filter(task => task.outcome === "done").length;
      const fill = h("span", { class: "progress-fill" });
      fill.style.width = `${related.length ? Math.round((done / related.length) * 100) : 0}%`;
      return h("button", { type: "button", class: "today-row project-row", "data-pad-row": project.id, onclick: () => this.navigate("work", project.id) },
        h("span", { class: "row-main" }, h("span", { class: "row-title" }, project.title),
          h("span", { class: "project-progress" }, h("span", { class: "progress" }, fill), h("span", { class: "ratio" }, related.length ? `${done}/${related.length}` : t("No tasks")))));
    }));
  }

  /** 一行输入框：问题直接带到助手页。 */
  private ask(): HTMLElement {
    const input = h("input", { type: "text", placeholder: t("Ask the assistant anything…"), "aria-label": t("Ask the assistant"), autocomplete: "off", enterkeyhint: "send" });
    const form = h("form", { class: "today-ask" }, icon("assistant"), input, h("button", { type: "submit", class: "icon-btn", title: t("Ask"), "aria-label": t("Ask") }, icon("send")));
    form.addEventListener("submit", event => { event.preventDefault(); const text = input.value.trim(); if (text) this.navigate("assistant", undefined, `ask:${text}`); });
    return form;
  }
}

/** 逾期在前，其次是今天到期，最后是进行中但没有期限的。 */
function byFocus(a: WorkTask, b: WorkTask): number {
  if (a.due && b.due) return a.due.localeCompare(b.due);
  if (a.due) return -1;
  if (b.due) return 1;
  return b.updated.localeCompare(a.updated);
}
const byDue = byFocus;

/** 规则判为重要的（需要你回答、验收、处理失败、待批准）已经在「需要你处理」里，这里不重复。 */
export function pendingNotices(notices: readonly Notice[]): Notice[] {
  return notices.filter(notice => !notice.read && notice.level !== "silent" && !(notice.level === "important" && notice.graded.by === "rule"));
}

/** 只取 Today 会显示的部分做指纹：运行的心跳等不影响这一页的字段变化时不重画。 */
function snapshotKey(snapshot: LiveSnapshot): unknown {
  const value = <T>(result: PromiseSettledResult<T>, pick: (value: T) => unknown = value => value) =>
    result.status === "fulfilled" ? pick(result.value) : { error: errorText(result.reason) };
  return [
    value(snapshot.tasks), value(snapshot.proposals), value(snapshot.attention), value(snapshot.notices), value(snapshot.jobAttention),
    value(snapshot.jobs, jobs => jobs.map(job => [job.spec.id, job.status, job.spec.created, job.result?.question, job.result?.error])),
  ];
}

/** 不属于任何任务提醒的运行（等你回答 / 失败）：Hub 已有任务提醒时，有任务的运行由提醒代表。 */
function attentionJobs(snapshot: LiveSnapshot): Job[] {
  const attention = settled(snapshot.attention);
  return executionGroups(settled(snapshot.jobs) ?? [], settled(snapshot.tasks), attention).needs
    .filter(job => attention === undefined || !job.spec.source?.task);
}

/** 「需要你处理」的卡片数；侧栏 Today 的数字用同一个算法，两边一致。 */
export function needsYouCount(snapshot: LiveSnapshot): number {
  const approvals = settled(snapshot.proposals);
  return (settled(snapshot.jobAttention)?.length ?? 0) + (settled(snapshot.attention)?.length ?? 0)
    + (settled(snapshot.jobs) ? attentionJobs(snapshot).length : 0) + (approvals?.length ?? 0);
}
