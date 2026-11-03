/** 今日：一句话说清现状，左侧是要推进的任务，右侧是需要你处理的事和运行动态。各区块独立失败。 */
import type { Job, Proposal, WorkProject, WorkTask } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { formatTime } from "../commands.ts";
import { clear, failure, h, icon, loading, statusIcon } from "../dom.ts";
import { ago, dueLabel, jobTitle } from "../format.ts";
import { JOB_LABELS } from "../labels.ts";
import type { Navigate } from "../navigation.ts";
import { t, tParts, locale } from "../i18n.ts";

const LIVE = ["queued", "assigned", "running"];
const ATTENTION = ["waiting_for_human", "failed", "unknown"];

export class OverviewPane {
  private body = h("div", { class: "today-inner" });
  private generation = 0;
  private active = true;

  constructor(owner: HTMLElement, private client: Client, private navigate: Navigate) {
    owner.append(h("div", { class: "today" }, this.body));
    clear(this.body, loading(t("Gathering today's work…")));
    void this.load();
  }
  dispose(): void { this.active = false; this.generation++; }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    const [tasks, projects, jobs, approvals] = await Promise.allSettled([this.client.workTasks(), this.client.workProjects(), this.client.jobs(), this.client.proposals("pending")]);
    if (!this.active || generation !== this.generation) return;
    const taskData = tasks.status === "fulfilled" ? tasks.value : undefined;
    const projectData = projects.status === "fulfilled" ? projects.value : [];
    const jobData = jobs.status === "fulfilled" ? jobs.value : undefined;
    const approvalData = approvals.status === "fulfilled" ? approvals.value : undefined;

    const active = taskData?.filter(t => t.status === "active") ?? [];
    const todo = (taskData?.filter(t => t.status === "todo") ?? []).sort(byDue);
    const waiting = taskData?.filter(t => t.status === "waiting") ?? [];
    const running = jobData?.filter(j => LIVE.includes(j.status)) ?? [];
    const attentionJobs = jobData?.filter(j => ATTENTION.includes(j.status)) ?? [];

    const date = new Intl.DateTimeFormat(locale(), { month: "long", day: "numeric", weekday: "long" }).format(new Date());
    const num = (n: number) => h("span", { class: `num${n ? "" : " zero"}` }, n);
    const decide = (approvalData?.length ?? 0) + attentionJobs.length;
    const headline = h("h1", { class: "today-headline" });
    if (taskData) {
      headline.append(...tParts("{0} in progress, {1} to do. ", num(active.length), num(todo.length)));
      if (running.length) headline.append(...tParts(running.length === 1 ? "Agents are running {0} round. " : "Agents are running {0} rounds. ", num(running.length)));
      if (decide) headline.append(...tParts(decide === 1 ? "{0} item needs your decision." : "{0} items need your decision.", num(decide)));
      else headline.append(running.length ? t("Nothing needs your decision.") : t("Nothing needs your decision right now."));
    } else headline.append(t("Today"));

    clear(this.body,
      h("p", { class: "today-date" }, date),
      headline,
      h("div", { class: "today-grid" },
        h("div", { class: "today-col" },
          this.block(t("In progress"), active.length, "work", tasks.status === "rejected" ? failure(errorText(tasks.reason)) : this.taskList(active, projectData, t("Nothing in progress. Pick something from your to-do list."))),
          this.block(t("To do"), todo.length, "work", tasks.status === "rejected" ? null : this.taskList(todo.slice(0, 8), projectData, t("Your to-do list is clear."))),
          waiting.length ? this.block(t("Waiting"), waiting.length, "work", this.taskList(waiting, projectData, "")) : null),
        h("div", { class: "today-col" },
          this.attention(approvalData, attentionJobs, approvals.status === "rejected" ? approvals.reason : undefined, taskData ?? []),
          this.block(t("Recent runs"), running.length, "execution", jobs.status === "rejected" ? failure(errorText(jobs.reason)) : this.runs(jobData ?? [], taskData ?? [])),
          this.block(t("Projects"), projectData.filter(p => p.status !== "done").length, "work", projects.status === "rejected" ? failure(errorText(projects.reason)) : this.projects(projectData, taskData ?? [])),
          this.ask())));
  }

  private block(title: string, count: number, section: "work" | "execution" | "approvals", body: Node | null): HTMLElement {
    return h("section", {},
      h("header", { class: "block-head" }, h("h2", {}, title), h("span", { class: "count" }, count || ""),
        h("button", { type: "button", class: "text-btn", onclick: () => this.navigate(section) }, t("All"))),
      body);
  }

  private taskList(tasks: WorkTask[], projects: WorkProject[], emptyText: string): HTMLElement {
    if (!tasks.length) return h("p", { class: "muted state" }, emptyText);
    return h("div", {}, ...tasks.map(task => {
      const due = dueLabel(task.due);
      const project = projects.find(p => p.id === task.project)?.title;
      return h("button", { type: "button", class: "row", onclick: () => this.navigate("work", task.id) },
        statusIcon(task.status),
        h("span", { class: "row-main" }, h("span", { class: "row-title" }, task.title)),
        h("span", { class: "row-meta" },
          project && h("span", { class: "project-chip hide-narrow" }, project),
          task.assignee !== "human" && h("span", { class: "who-chip" }, icon("bot"), task.assignee),
          due && h("span", { class: `due${due.overdue ? " overdue" : due.soon ? " soon" : ""}` }, due.text)));
    }));
  }

  private attention(approvals: Proposal[] | undefined, jobs: Job[], error: unknown, tasks: WorkTask[]): HTMLElement | null {
    if (error) return this.block(t("Needs your decision"), 0, "approvals", failure(errorText(error)));
    const items = [
      ...(approvals ?? []).map(p => h("button", { type: "button", class: "row", onclick: () => this.navigate("approvals") },
        icon("approvals"), h("span", { class: "row-main" }, h("span", { class: "row-title" }, p.operation.op === "exec.privileged" ? p.operation.args.argv.join(" ") : p.operation.op),
          h("span", { class: "row-sub" }, p.reason)), h("span", { class: "pill pill-ochre" }, t("Pending")))),
      ...jobs.map(j => h("button", { type: "button", class: "row", onclick: () => this.navigate("execution", j.spec.id) },
        statusIcon(j.status), h("span", { class: "row-main" }, h("span", { class: "row-title" }, jobTitle(j, tasks)), h("span", { class: "row-sub" }, j.result?.question ?? j.result?.error ?? "")),
        h("span", { class: `pill ${j.status === "waiting_for_human" ? "pill-ochre" : "pill-red"}` }, JOB_LABELS[j.status]))),
    ];
    if (!items.length) return null;
    return h("section", {}, h("header", { class: "block-head" }, h("h2", {}, t("Needs your decision")), h("span", { class: "count" }, items.length)), ...items);
  }

  private runs(jobs: Job[], tasks: WorkTask[]): HTMLElement {
    const recent = jobs.slice().sort((a, b) => b.spec.created.localeCompare(a.spec.created)).slice(0, 5);
    if (!recent.length) return h("p", { class: "muted state" }, t("No runs yet. Click Dispatch on a task and each agent round shows up here."));
    return h("div", {}, ...recent.map(job => h("button", { type: "button", class: "row", onclick: () => this.navigate("execution", job.spec.id) },
      statusIcon(job.status),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, jobTitle(job, tasks))),
      h("span", { class: "row-meta", title: formatTime(job.spec.created) }, ago(job.spec.created)))));
  }

  private projects(projects: WorkProject[], tasks: WorkTask[]): HTMLElement {
    const open = projects.filter(p => p.status !== "done").slice(0, 5);
    if (!open.length) return h("p", { class: "muted state" }, t("No active projects."));
    return h("div", {}, ...open.map(project => {
      const related = tasks.filter(t => t.project === project.id && t.status !== "cancelled");
      const done = related.filter(t => t.status === "done").length;
      const fill = h("span", { class: "progress-fill" });
      fill.style.width = `${related.length ? Math.round((done / related.length) * 100) : 0}%`;
      return h("button", { type: "button", class: "project-line", onclick: () => this.navigate("work", project.id) },
        h("span", { class: "row-main" }, h("span", { class: "row-title" }, project.title), project.goal && h("span", { class: "row-sub" }, project.goal)),
        h("span", { class: "progress" }, fill), h("span", { class: "ratio" }, related.length ? `${done}/${related.length}` : "—"));
    }));
  }

  private ask(): HTMLElement {
    const input = h("input", { type: "text", placeholder: t("For example: list the experiments still missing for the rebuttal"), "aria-label": t("Ask the assistant"), autocomplete: "off" });
    const form = h("form", {}, input, h("button", { type: "submit", class: "btn" }, t("Ask")));
    form.addEventListener("submit", event => { event.preventDefault(); const text = input.value.trim(); if (text) this.navigate("assistant", undefined, `ask:${text}`); });
    return h("section", { class: "ask-card" }, h("h2", {}, t("Ask the assistant")), h("p", {}, t("The assistant only uses the model configured on your Hub. Chatting doesn't give it access to your tasks or private notes.")), form);
  }
}

function byDue(a: WorkTask, b: WorkTask): number {
  if (a.due && b.due) return a.due.localeCompare(b.due);
  if (a.due) return -1;
  if (b.due) return 1;
  return b.updated.localeCompare(a.updated);
}
