/**
 * 今日：先是需要你处理的事（轮到你回答 / 验收 / 处理失败、待批准），再是你的待办，
 * 然后是 agent 在做的和在等外部的（ADR 0032）；旁边是 agent 动态与项目进度。
 * 各区块独立加载失败；不在这里放统计大字。
 */
import type { Job, Proposal, WorkAttention, WorkProject, WorkTask } from "@lumio/schema";
import { errorText, type Client, type HubExtras } from "../api.ts";
import { executionGroups } from "../execution-groups.ts";
import { attentionCard } from "../attention-card.ts";
import { engineTargets, formatTime, newRequestId } from "../commands.ts";
import { quickDelegateTarget, quickDispatchCommand, nextTargetText } from "../delegate.ts";
import { clear, failure, h, icon, loading, openMenu, statusIcon, toast } from "../dom.ts";
import { ago, dueLabel, jobTitle } from "../format.ts";
import { JOB_LABELS } from "../labels.ts";
import type { Navigate } from "../navigation.ts";
import { taskTurnMenu } from "../turn-menu.ts";
import { locale, t } from "../i18n.ts";
import { turnGroup, turnIcon, turnText } from "../turn.ts";
import { isWorkProposal, proposalCard } from "../proposal-card.ts";

const LIVE = ["queued", "assigned", "running"];
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
  /** 静默刷新；卡片里正在输入或正在提交时不打断。 */
  liveRefresh(): void {
    const typing = [...this.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")].some(el => el.value.trim());
    if (typing || this.body.querySelector(".is-busy")) return;
    void this.load();
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
    const mine = taskData?.filter(task => turnGroup(task) === "todo") ?? [];
    const dueSoon = (task: WorkTask) => !!task.due && new Date(task.due).getTime() < endOfToday;
    // 今天：今天到期或已逾期的待办；没有的话，最近交回给你的排在前面。
    const focus = mine.filter(dueSoon).sort(byFocus);
    const next = mine.filter(task => !focus.includes(task)).sort(byDue);
    const agentsWorking = taskData?.filter(task => turnGroup(task) === "agents") ?? [];
    const waiting = taskData?.filter(task => turnGroup(task) === "external") ?? [];
    const running = jobData?.filter(job => LIVE.includes(job.status)) ?? [];
    // ADR 0032：任务提醒按当前交接；旧 Hub 与独立运行使用同一套回退规则。
    const attentionData = attention.status === "fulfilled" ? attention.value : undefined;
    const attentionJobs = executionGroups(jobData ?? [], taskData, attentionData).needs
      .filter(job => attentionData === undefined || !job.spec.source?.task);

    const needCount = (attentionData?.length ?? 0) + attentionJobs.length + (approvalData?.length ?? 0);
    const parts = taskData ? [
      needCount ? t(needCount === 1 ? "{0} needs you" : "{0} need you", needCount) : "",
      t(mine.length === 1 ? "{0} to-do" : "{0} to-dos", mine.length),
      agentsWorking.length ? t(agentsWorking.length === 1 ? "{0} task with agents" : "{0} tasks with agents", agentsWorking.length) : "",
    ].filter(Boolean) : [];

    clear(this.body,
      this.header(parts.join(t(" · "))),
      this.ask(),
      h("div", { class: "today-grid" },
        h("div", { class: "today-col" },
          this.needsYou(approvalData, attentionJobs, approvals.status === "rejected" ? approvals.reason : undefined, taskData ?? [], attentionData ?? []),
          focus.length || tasks.status === "rejected" ? this.section("due", t("Due today"), focus.length, () => this.navigate("work", "tasks"),
            tasks.status === "rejected" ? failure(errorText(tasks.reason)) : this.taskList(focus, projectData, "")) : null,
          tasks.status === "fulfilled" ? this.section("todo", focus.length ? t("Your other to-dos") : t("Your to-dos"), next.length, () => this.navigate("work", "tasks"), this.taskList(next.slice(0, 6), projectData, focus.length ? t("Nothing else on your list.") : t("Your to-do list is clear."))) : null,
          agentsWorking.length ? this.section("active", t("Agents working"), agentsWorking.length, () => this.navigate("work", "tasks"), this.taskList(agentsWorking, projectData, "")) : null,
          waiting.length ? this.section("waiting", t("Waiting on others"), waiting.length, () => this.navigate("work", "tasks"), this.taskList(waiting, projectData, "")) : null),
        h("div", { class: "today-col today-side" },
          this.section("runs", t("Agent activity"), running.length, () => this.navigate("execution"),
            jobs.status === "rejected" ? failure(errorText(jobs.reason)) : this.runs(jobData ?? [], taskData ?? [])),
          this.section("projects", t("Projects"), projectData.filter(p => p.status !== "done").length, () => this.navigate("work", "projects"),
            projects.status === "rejected" ? failure(errorText(projects.reason)) : this.projects(projectData, taskData ?? [])))));
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
      const next = quickDelegateTarget(task);
      const delegation = next && this.delegateActions(task, next);
      row.addEventListener("lumio-task-menu", () => {
        const pick = delegation?.querySelector<HTMLButtonElement>(".today-delegate-pick:not(:disabled)");
        taskTurnMenu(this.client, task, row, () => { this.changed(); void this.load(); }, () => { void this.load(); },
          pick ? [{ label: t("Delegate to someone else"), run: () => pick.click() }] : []);
      });
      return delegation ? h("div", { class: "today-row-wrap" }, row, delegation) : row;
    }));
  }

  /** 一键委派（ADR 0044）：按 Hub 推导的目标派出；小箭头换人，之后这个任务一直交给新的 agent。 */
  private delegateActions(task: WorkTask, next: NonNullable<WorkTask["next_target"]>): HTMLElement {
    const go = h("button", { type: "button", class: "btn btn-small today-delegate", "data-pad-action": "delegate", title: t("Delegate to {0}", nextTargetText(next)), "aria-label": t("Delegate to {0}", next.target) },
      icon("play"), h("span", { class: "today-delegate-label" }, t("Delegate")));
    const pick = h("button", { type: "button", class: "btn btn-small today-delegate-pick", title: next.source === "plan" ? t("Set by the plan step") : t("Delegate to someone else"),
      "aria-label": t("Delegate to someone else"), disabled: next.source === "plan" }, icon("down"));
    const group = h("span", { class: "today-delegate-group" }, go, pick);
    let requestId = newRequestId(), previous: string | undefined;
    const send = async (to?: string) => {
      if (group.classList.contains("is-busy")) return;
      if (previous !== undefined && previous !== (to ?? "")) requestId = newRequestId();
      previous = to ?? "";
      group.classList.add("is-busy"); go.disabled = pick.disabled = true;
      try {
        const result = await this.client.workCommand(quickDispatchCommand(task, to, requestId));
        const who = result.kind === "job" ? result.target ?? to ?? next.target : to ?? next.target;
        if (result.kind === "proposal") toast(t("Waiting for your approval"));
        else if (result.kind === "job") toast(t("Dispatched to {0}", who), "ok", {
          label: t("View run"), run: () => this.navigate("execution", result.job.spec.id, "from-dispatch-toast"),
        });
        this.changed();
        void this.load();
      } catch (cause) {
        toast(errorText(cause), "error");
        group.classList.remove("is-busy"); go.disabled = false; pick.disabled = next.source === "plan";
        void this.load();
      }
    };
    go.addEventListener("click", () => void send());
    pick.addEventListener("click", async () => {
      try {
        const targets = engineTargets(await this.client.runtimes());
        openMenu(pick, targets.map(x => ({ value: x.target, label: x.label, selected: x.target === next.target, icon: icon("bot") })), value => void send(value));
      } catch (cause) { toast(errorText(cause), "error"); }
    });
    return group;
  }

  private needsYou(approvals: Proposal[] | undefined, jobs: Job[], error: unknown, tasks: WorkTask[], rounds: WorkAttention[]): HTMLElement | null {
    if (error) return this.section("needs", t("Needs you"), 0, undefined, failure(errorText(error)));
    const context = { client: this.client, hub: this.hub, navigate: this.navigate, changed: () => { this.changed(); setTimeout(() => void this.load(), 1200); } };
    const cards = [
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
    const live = jobs.filter(job => LIVE.includes(job.status));
    const recent = jobs.filter(job => !LIVE.includes(job.status)).sort((a, b) => b.spec.created.localeCompare(a.spec.created));
    const shown = [...live, ...recent].slice(0, 5);
    if (!shown.length) return h("p", { class: "today-empty" }, t("No agent runs yet. Delegate a task and each round shows up here."));
    return h("div", { class: "today-rows" }, ...shown.map(job => h("button", { type: "button", class: "today-row", "data-pad-row": job.spec.id, onclick: () => this.navigate("execution", job.spec.id) },
      statusIcon(job.status),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, jobTitle(job, tasks)),
        h("span", { class: "row-sub" }, `${job.spec.run.kind === "agent" ? job.spec.run.engine : t("Command")}${t(" · ")}${JOB_LABELS[job.status] ?? job.status}`)),
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
