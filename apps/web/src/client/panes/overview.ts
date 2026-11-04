/**
 * 今日：先是需要你处理的事，再是今天要推进的任务，旁边是 agent 动态与项目进度。
 * 各区块独立加载失败；不在这里放统计大字。
 */
import type { Job, Proposal, WorkAttention, WorkProject, WorkTask } from "@lumio/schema";
import { errorText, type Client, type HubExtras } from "../api.ts";
import { attentionCard } from "../attention-card.ts";
import { formatTime } from "../commands.ts";
import { clear, failure, h, icon, loading, statusIcon } from "../dom.ts";
import { ago, dueLabel, jobTitle } from "../format.ts";
import { JOB_LABELS } from "../labels.ts";
import type { Navigate } from "../navigation.ts";
import { locale, t } from "../i18n.ts";

const LIVE = ["queued", "assigned", "running"];
const ATTENTION = ["waiting_for_human", "failed", "unknown"];
const DAY = 86_400_000;

export class OverviewPane {
  private body = h("div", { class: "today-inner" });
  private generation = 0;
  private active = true;

  constructor(owner: HTMLElement, private client: Client, private hub: HubExtras, private navigate: Navigate, private name: string, private changed: () => void = () => {}) {
    owner.append(h("div", { class: "today" }, this.body));
    clear(this.body, this.header(), loading(t("Gathering today's work…")));
    void this.load();
  }
  dispose(): void { this.active = false; this.generation++; }

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

  private async load(): Promise<void> {
    const generation = ++this.generation;
    const [tasks, projects, jobs, approvals, attention] = await Promise.allSettled([this.client.workTasks(), this.client.workProjects(), this.client.jobs(), this.client.proposals("pending"), this.hub.attention()]);
    if (!this.active || generation !== this.generation) return;
    const taskData = tasks.status === "fulfilled" ? tasks.value : undefined;
    const projectData = projects.status === "fulfilled" ? projects.value : [];
    const jobData = jobs.status === "fulfilled" ? jobs.value : undefined;
    const approvalData = approvals.status === "fulfilled" ? approvals.value : undefined;

    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + DAY;
    const open = taskData?.filter(task => task.status === "active" || task.status === "todo") ?? [];
    const dueSoon = (task: WorkTask) => !!task.due && new Date(task.due).getTime() < endOfToday;
    const focus = open.filter(task => task.status === "active" || dueSoon(task)).sort(byFocus);
    const next = open.filter(task => !focus.includes(task)).sort(byDue);
    const waiting = taskData?.filter(task => task.status === "waiting") ?? [];
    const running = jobData?.filter(job => LIVE.includes(job.status)) ?? [];
    // ADR 0030：Hub 按每个任务最新一轮给出需要处理的事；旧 Hub 没有接口时退回按 Job 状态显示（例行任务的轮次也走这里）。
    const attentionData = attention.status === "fulfilled" ? attention.value : undefined;
    const attentionJobs = jobData?.filter(job => ATTENTION.includes(job.status) && (!attentionData || !job.spec.source?.task)) ?? [];

    const parts = taskData ? [
      t(focus.length === 1 ? "{0} task for today" : "{0} tasks for today", focus.length),
      running.length ? t(running.length === 1 ? "{0} agent running" : "{0} agents running", running.length) : "",
    ].filter(Boolean) : [];

    clear(this.body,
      this.header(parts.join(t(" · "))),
      this.ask(),
      h("div", { class: "today-grid" },
        h("div", { class: "today-col" },
          this.needsYou(approvalData, attentionJobs, approvals.status === "rejected" ? approvals.reason : undefined, taskData ?? [], attentionData ?? []),
          this.section(t("Today"), focus.length, () => this.navigate("work"),
            tasks.status === "rejected" ? failure(errorText(tasks.reason)) : this.taskList(focus, projectData, t("Nothing due today. Pick something from Up next."))),
          tasks.status === "fulfilled" && (next.length || !focus.length) ? this.section(t("Up next"), next.length, () => this.navigate("work"), this.taskList(next.slice(0, 6), projectData, t("Your to-do list is clear."))) : null,
          waiting.length ? this.section(t("Waiting on others"), waiting.length, () => this.navigate("work"), this.taskList(waiting, projectData, "")) : null),
        h("div", { class: "today-col today-side" },
          this.section(t("Agent activity"), running.length, () => this.navigate("execution"),
            jobs.status === "rejected" ? failure(errorText(jobs.reason)) : this.runs(jobData ?? [], taskData ?? [])),
          this.section(t("Projects"), projectData.filter(p => p.status !== "done").length, () => this.navigate("work"),
            projects.status === "rejected" ? failure(errorText(projects.reason)) : this.projects(projectData, taskData ?? [])))));
  }

  private section(title: string, count: number, all: (() => void) | undefined, body: Node | null): HTMLElement {
    return h("section", { class: "today-section" },
      h("header", { class: "today-section-head" }, h("h2", {}, title), count ? h("span", { class: "count" }, count) : null,
        all && h("button", { type: "button", class: "text-btn", onclick: all }, t("All"))),
      h("div", { class: "today-card" }, body));
  }

  private taskList(tasks: WorkTask[], projects: WorkProject[], emptyText: string): HTMLElement {
    if (!tasks.length) return h("p", { class: "today-empty" }, emptyText);
    return h("div", { class: "today-rows" }, ...tasks.map(task => {
      const due = dueLabel(task.due);
      const project = projects.find(p => p.id === task.project)?.title;
      return h("button", { type: "button", class: "today-row", onclick: () => this.navigate("work", task.id) },
        statusIcon(task.status),
        h("span", { class: "row-main" }, h("span", { class: "row-title" }, task.title),
          (project || task.assignee !== "human") && h("span", { class: "row-sub" },
            project && h("span", { class: "project-chip" }, icon("folder"), project),
            task.assignee !== "human" && h("span", { class: "who-chip" }, icon("bot"), task.assignee))),
        due && h("span", { class: `due-tag${due.overdue ? " overdue" : due.soon ? " soon" : ""}` }, due.overdue ? t("Overdue · {0}", due.text) : due.text));
    }));
  }

  private needsYou(approvals: Proposal[] | undefined, jobs: Job[], error: unknown, tasks: WorkTask[], rounds: WorkAttention[]): HTMLElement | null {
    if (error) return this.section(t("Needs you"), 0, undefined, failure(errorText(error)));
    const context = { client: this.client, hub: this.hub, navigate: this.navigate, changed: () => { this.changed(); setTimeout(() => void this.load(), 1200); } };
    const cards = [
      ...rounds.map(item => attentionCard(item, context, "today")),
      ...(approvals ?? []).map(p => this.needCard("approvals", "ochre",
        p.operation.op === "exec.privileged" ? p.operation.args.argv.join(" ") : p.operation.op, p.reason, t("Approval"), t("Review"), () => this.navigate("approvals"))),
      ...jobs.map(j => j.status === "waiting_for_human"
        ? this.needCard("help", "ochre", jobTitle(j, tasks), j.result?.question ?? "", JOB_LABELS[j.status] ?? j.status, t("Answer"), () => this.navigate("execution", j.spec.id))
        : this.needCard("alert", "red", jobTitle(j, tasks), j.result?.error ?? "", JOB_LABELS[j.status] ?? j.status, t("View"), () => this.navigate("execution", j.spec.id))),
    ];
    if (!cards.length) return null;
    return h("section", { class: "today-section" },
      h("header", { class: "today-section-head" }, h("h2", {}, t("Needs you")), h("span", { class: "count attention" }, cards.length)),
      h("div", { class: "needs" }, ...cards));
  }

  private needCard(glyph: string, tone: "ochre" | "red", title: string, detail: string, kind: string, action: string, go: () => void): HTMLElement {
    return h("article", { class: `need need-${tone}` },
      h("span", { class: "need-icon" }, icon(glyph)),
      h("div", { class: "need-main" },
        h("p", { class: "need-kind" }, kind),
        h("button", { type: "button", class: "need-title", onclick: go }, title),
        detail && h("p", { class: "need-detail" }, detail)),
      h("button", { type: "button", class: "btn btn-small need-action", onclick: go }, action));
  }

  private runs(jobs: Job[], tasks: WorkTask[]): HTMLElement {
    const live = jobs.filter(job => LIVE.includes(job.status));
    const recent = jobs.filter(job => !LIVE.includes(job.status)).sort((a, b) => b.spec.created.localeCompare(a.spec.created));
    const shown = [...live, ...recent].slice(0, 5);
    if (!shown.length) return h("p", { class: "today-empty" }, t("No agent runs yet. Dispatch a task and each round shows up here."));
    return h("div", { class: "today-rows" }, ...shown.map(job => h("button", { type: "button", class: "today-row", onclick: () => this.navigate("execution", job.spec.id) },
      statusIcon(job.status),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, jobTitle(job, tasks)),
        h("span", { class: "row-sub" }, `${job.spec.run.kind === "agent" ? job.spec.run.engine : t("Command")}${t(" · ")}${JOB_LABELS[job.status] ?? job.status}`)),
      h("span", { class: "row-time", title: formatTime(job.spec.created) }, ago(job.spec.created)))));
  }

  private projects(projects: WorkProject[], tasks: WorkTask[]): HTMLElement {
    const open = projects.filter(p => p.status !== "done").slice(0, 5);
    if (!open.length) return h("p", { class: "today-empty" }, t("No active projects."));
    return h("div", { class: "today-rows" }, ...open.map(project => {
      const related = tasks.filter(task => task.project === project.id && task.status !== "cancelled");
      const done = related.filter(task => task.status === "done").length;
      const fill = h("span", { class: "progress-fill" });
      fill.style.width = `${related.length ? Math.round((done / related.length) * 100) : 0}%`;
      return h("button", { type: "button", class: "today-row project-row", onclick: () => this.navigate("work", project.id) },
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
