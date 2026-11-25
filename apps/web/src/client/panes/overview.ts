/**
 * 今日：先是需要你处理的事（轮到你回答 / 验收 / 处理失败、待批准），再是你的待办，
 * 然后是 agent 在做的和在等外部的（ADR 0032）；旁边是 agent 动态与项目进度。
 * 各区块独立加载失败；不在这里放统计大字。
 */
import type { ExecutionOverview, ExecutionOverviewItem, JobAttention, Notice, Proposal, WorkAttention, WorkProject, WorkTask } from "@lumio/schema";
import { openResource } from "../resources.ts";
import { noticePreview, noticeTitle } from "../workbench-assist.ts";
import { errorText, type Client, type HubExtras } from "../api.ts";
import { attentionCard } from "../attention-card.ts";
import { formatTime, newRequestId } from "../commands.ts";
import { quickDelegateActions } from "../delegate.ts";
import { clear, failure, h, icon, loading, statusIcon, toast } from "../dom.ts";
import { ago, dueLabel } from "../format.ts";
import { JOB_LABELS } from "../labels.ts";
import type { Navigate } from "../navigation.ts";
import { taskTurnMenu } from "../turn-menu.ts";
import { locale, t } from "../i18n.ts";
import { turnGroup, turnIcon, turnText } from "../turn.ts";
import { isWorkProposal, proposalCard } from "../proposal-card.ts";
import { jobActivityBadge } from "../job-activity.ts";
import { personalSchedule } from "./personal.ts";
import { LiveData, settled, settleRead, type AttentionSnapshot, type LiveSnapshot } from "../live-data.ts";

type Personal = Awaited<ReturnType<NonNullable<HubExtras["personalView"]>>>;
type Region = "header" | "tasks" | "needs" | "notices" | "personal" | "activity" | "projects";

const LIVE = ["queued", "assigned", "running"];
const DAY = 86_400_000;

function overviewTitle(run: ExecutionOverviewItem, tasks: WorkTask[]): string {
  if (run.task) return tasks.find(task => task.id === run.task)?.title ?? t("Task round {0}", run.round ?? "");
  if (run.routine) return t("Routine");
  return run.engine ? t("{0} run", run.engine) : run.label || t("Command");
}

export class OverviewPane {
  private body = h("div", { class: "today-inner" });
  private generation = 0;
  private active = true;
  private regions = new Map<Region, { element: HTMLElement; signature?: string }>();
  private projectData: WorkProject[] = [];
  private projectRequest?: Promise<PromiseSettledResult<WorkProject[]>>;
  private personalRequest?: Promise<Personal>;
  /** 「需要你处理」里展开了完整汇报的卡片（按轮次），刷新后保持展开。 */
  private expanded = new Set<string>();
  private live: LiveData;

  constructor(owner: HTMLElement, private client: Client, private hub: HubExtras, private navigate: Navigate, private name: string, private changed: () => void = () => {}, live?: LiveData) {
    this.live = live ?? new LiveData(client, hub);
    owner.append(h("div", { class: "today" }, this.body));
    const group = (key: Region, ...children: HTMLElement[]) => {
      const element = h("div", { class: "today-group" }, ...children);
      this.regions.set(key, { element });
      return element;
    };
    clear(this.body, group("header", this.header()), this.ask(),
      h("div", { class: "today-grid" },
        h("div", { class: "today-col" }, group("needs"), group("notices"), group("tasks", loading(t("Gathering today's work…")))),
        h("div", { class: "today-col today-side" }, group("personal"), group("activity"), group("projects"))));
    void this.load();
  }
  dispose(): void { this.active = false; this.generation++; }
  liveRefresh(): void { void this.load(2000); }

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

  /** Each section owns its DOM. A late response must not replace another section's input, focus or expanded cards. */
  private draw(key: Region, data: unknown, render: () => (HTMLElement | null)[]): void {
    const region = this.regions.get(key)!;
    const signature = JSON.stringify(data);
    if (region.signature === signature) return;
    const focused = document.activeElement;
    if ((focused && region.element.contains(focused)) || region.element.querySelector(".is-busy")) return;
    if ([...region.element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")].some(field => field.value.trim())) return;
    clear(region.element, ...render());
    region.signature = signature;
  }

  private async load(maxAge = 0): Promise<void> {
    const generation = ++this.generation;
    const current = () => this.active && generation === this.generation;
    const read = this.live.read(maxAge);
    const projects = this.projectRequest ??= settleRead(this.client.workProjects()).finally(() => { this.projectRequest = undefined; });
    const personal = this.personalRequest ??= Promise.resolve(this.hub.personalView?.()).catch(() => undefined)
      .finally(() => { this.personalRequest = undefined; });
    let tasks: LiveSnapshot["tasks"] | undefined;
    let execution: LiveSnapshot["execution"] | undefined;
    let attention: AttentionSnapshot | undefined;
    await Promise.all([
      read.tasks.then(result => {
        if (!current()) return;
        tasks = result;
        this.renderTasks(tasks, this.projectData);
        if (execution) this.renderActivity(execution, settled(tasks) ?? []);
        if (attention) this.renderAttention(attention, settled(tasks));
      }),
      read.execution.then(result => {
        if (!current()) return;
        execution = result;
        this.renderActivity(result, tasks ? settled(tasks) ?? [] : []);
      }),
      read.attention.then(result => {
        if (!current()) return;
        attention = result;
        this.renderAttention(result, tasks ? settled(tasks) : undefined);
      }),
      read.notices.then(notices => {
        if (current()) this.draw("notices", notices, () => [notices.status === "fulfilled" ? this.pending(pendingNotices(notices.value)) : null]);
      }),
      personal.then(value => {
        if (current()) this.draw("personal", [value?.events, value?.todos, value?.sync_ok, value?.timezone, new Date().toDateString()], () => [this.personal(value)]);
      }),
      Promise.all([projects, read.tasks]).then(([result, tasks]) => {
        if (!current()) return;
        const projectData = settled(result) ?? [];
        if (projectData.length !== this.projectData.length || projectData.some((project, i) =>
          project.id !== this.projectData[i]?.id || project.title !== this.projectData[i]?.title)) {
          this.projectData = projectData;
          this.renderTasks(tasks, projectData);
        }
        const taskData = settled(tasks) ?? [];
        this.draw("projects", [result, taskData.map(task => [task.project, task.outcome])], () => [
          this.section("projects", t("Projects"), projectData.filter(p => p.status !== "done").length, () => this.navigate("work", "projects"),
            result.status === "rejected" ? failure(errorText(result.reason)) : this.projects(projectData, taskData)),
        ]);
      }),
    ]);
  }

  private renderTasks(tasks: LiveSnapshot["tasks"], projectData: WorkProject[]): void {
    const taskData = settled(tasks);
    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + DAY;
    const mine = taskData?.filter(task => turnGroup(task) === "todo") ?? [];
    const dueSoon = (task: WorkTask) => !!task.due && new Date(task.due).getTime() < endOfToday;
    // 今天：今天到期或已逾期的待办；没有的话，最近交回给你的排在前面。
    const focus = mine.filter(dueSoon).sort(byFocus);
    const next = mine.filter(task => !focus.includes(task)).sort(byDue);
    const agentsWorking = taskData?.filter(task => turnGroup(task) === "agents") ?? [];
    const waiting = taskData?.filter(task => turnGroup(task) === "external") ?? [];
    this.draw("tasks", [tasks, projectData.map(project => [project.id, project.title]), now.toDateString()], () => [
      focus.length || tasks.status === "rejected" ? this.section("due", t("Due today"), focus.length, () => this.navigate("work", "tasks"),
        tasks.status === "rejected" ? failure(errorText(tasks.reason)) : this.taskList(focus, projectData, "")) : null,
      tasks.status === "fulfilled" ? this.section("todo", focus.length ? t("Your other to-dos") : t("Your to-dos"), next.length, () => this.navigate("work", "tasks"), this.taskList(next.slice(0, 6), projectData, focus.length ? t("Nothing else on your list.") : t("Your to-do list is clear."))) : null,
      agentsWorking.length ? this.section("active", t("Agents working"), agentsWorking.length, () => this.navigate("work", "tasks"), this.taskList(agentsWorking, projectData, "")) : null,
      waiting.length ? this.section("waiting", t("Waiting on others"), waiting.length, () => this.navigate("work", "tasks"), this.taskList(waiting, projectData, "")) : null,
    ]);
  }

  private renderAttention(snapshot: AttentionSnapshot, taskData: WorkTask[] | undefined): void {
    const { execution, proposals, attention, jobAttention } = snapshot;
    const overview = settled(execution);
    const needCount = needsYouCount(snapshot);
    const mine = taskData?.filter(task => turnGroup(task) === "todo").length ?? 0;
    const working = taskData?.filter(task => turnGroup(task) === "agents").length ?? 0;
    const parts = taskData ? [
      needCount ? t(needCount === 1 ? "{0} needs you" : "{0} need you", needCount) : "",
      t(mine === 1 ? "{0} to-do" : "{0} to-dos", mine),
      working ? t(working === 1 ? "{0} task with agents" : "{0} tasks with agents", working) : "",
    ].filter(Boolean) : [];
    this.draw("header", [parts, new Date().toDateString()], () => [this.header(parts.join(t(" · ")))]);
    const standalone = overview?.standalone_attention;
    const issue = [execution, proposals, attention, jobAttention].find(result => result.status === "rejected");
    const requestTitles = settled(jobAttention)?.map(request => taskData?.find(task => task.id === request.task)?.title);
    this.draw("needs", [proposals, attention, jobAttention, standalone, requestTitles, issue && errorText(issue.reason)], () => [
      this.needsYou(settled(proposals), standalone, issue?.reason,
        taskData ?? [], settled(attention) ?? [], settled(jobAttention) ?? []),
    ]);
  }

  private renderActivity(execution: LiveSnapshot["execution"], tasks: WorkTask[]): void {
    const overview = settled(execution);
    const activity = overview?.activity ?? [];
    this.draw("activity", [execution.status, overview?.activity_live_count, activity, activity.map(job => overviewTitle(job, tasks))], () => [
      this.section("runs", t("Agent activity"), overview?.activity_live_count ?? 0, () => this.navigate("execution"),
        execution.status === "rejected" ? failure(errorText(execution.reason)) : this.runs(activity, tasks)),
    ]);
  }

  private personal(personal: Personal): HTMLElement | null {
    if (!personal) return null;
    const personalToday = new Intl.DateTimeFormat("sv-SE", { timeZone: personal.timezone, dateStyle: "short" }).format(new Date());
    const dateOf = (value: string, zone: string) =>
      new Intl.DateTimeFormat("sv-SE", { timeZone: zone, dateStyle: "short" }).format(new Date(value));
    const personalEvents = personal.events.filter(({ schedule }) => schedule.kind === "all_day"
      ? schedule.start <= personalToday && personalToday < schedule.end
      : dateOf(schedule.start, personal.timezone) <= personalToday && personalToday <= dateOf(new Date(Date.parse(schedule.end) - 1).toISOString(), personal.timezone));
    const personalTodos = personal.todos.filter(todo => todo.status === "open" && (!todo.due ||
      (todo.due.kind === "date" ? todo.due.date : dateOf(todo.due.at, personal.timezone)) <= personalToday));
    return this.section("personal", t("Personal"), personalEvents.length + personalTodos.length, () => this.navigate("personal"),
      h("div", { class: "today-personal", "data-private-personal": "true" },
        !personal.sync_ok ? h("p", { class: "today-empty" }, t("Calendar sync is pending or unavailable.")) : null,
        ...personalEvents.slice(0, 5).map(item => h("div", { class: "today-row" }, icon("calendar"),
          h("span", { class: "row-main" }, item.title, h("span", { class: "row-sub" }, personalSchedule(item.schedule))))),
        ...personalTodos.slice(0, 5).map(item => h("div", { class: "today-row" }, statusIcon("todo"), h("span", { class: "row-main" }, item.title))),
        personal.sync_ok && !personalEvents.length && !personalTodos.length
          ? h("p", { class: "today-empty" }, t("No personal events or to-dos due today.")) : null));
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

  private needsYou(approvals: Proposal[] | undefined, standalone: ExecutionOverview["standalone_attention"] | undefined, error: unknown, tasks: WorkTask[], rounds: WorkAttention[], liveRequests: JobAttention): HTMLElement | null {
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
      ...(standalone?.items ?? []).map(item => this.standaloneCard(item)),
    ];
    const count = cards.length + (standalone ? standalone.total - standalone.items.length : 0);
    if (!count && !error) return null;
    const list = h("div", { class: "needs" }, ...cards);
    let before = standalone?.next_before;
    const more = h("button", { type: "button", class: "text-btn", onclick: async () => {
      if (!before || more.disabled) return;
      more.disabled = true;
      try {
        const page = (await this.client.executionOverview(before)).standalone_attention;
        if (!this.active || !this.body.contains(more)) return;
        list.append(...page.items.map(item => this.standaloneCard(item)));
        before = page.next_before;
        if (!before) more.remove();
      } catch (cause) { toast(errorText(cause), "error"); }
      finally { more.disabled = false; }
    } }, t("Show older runs"));
    return h("section", { class: "today-section", "data-pad-region": "needs" },
      h("header", { class: "today-section-head" }, h("h2", {}, t("Needs you")), h("span", { class: "count attention" }, count)),
      error ? failure(errorText(error)) : null, list, before ? more : null);
  }

  private standaloneCard(item: ExecutionOverviewItem): HTMLElement {
    const question = item.status === "waiting_for_human";
    return this.needCard(item.id, question ? "help" : "alert", question ? "ochre" : "red", overviewTitle(item, []),
      item.preview ?? "", JOB_LABELS[item.status] ?? item.status, question ? t("Answer") : t("View"), () => this.navigate("execution", item.id));
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

  private runs(shown: ExecutionOverviewItem[], tasks: WorkTask[]): HTMLElement {
    if (!shown.length) return h("p", { class: "today-empty" }, t("No current agent activity."));
    return h("div", { class: "today-rows" }, ...shown.map(job => h("button", { type: "button", class: "today-row", "data-pad-row": job.id, onclick: () => this.navigate("execution", job.id) },
      statusIcon(job.status),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, overviewTitle(job, tasks)),
        h("span", { class: "row-sub" }, job.engine ?? t("Command"), " · ",
          LIVE.includes(job.status) ? jobActivityBadge(this.client, job.id, JOB_LABELS[job.status] ?? job.status) : JOB_LABELS[job.status] ?? job.status)),
      h("span", { class: "row-time", title: formatTime(job.created) }, ago(job.created)))));
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

/** 「需要你处理」的卡片数；侧栏 Today 的数字用同一个算法，两边一致。 */
export function needsYouCount(snapshot: AttentionSnapshot): number {
  const approvals = settled(snapshot.proposals);
  return (settled(snapshot.jobAttention)?.length ?? 0) + (settled(snapshot.attention)?.length ?? 0)
    + (settled(snapshot.execution)?.standalone_attention.total ?? 0) + (approvals?.length ?? 0);
}
