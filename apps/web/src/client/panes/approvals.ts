/**
 * 审批（ADR 0026）：待审批与历史。决定前完整显示操作、命令参数、所属执行与理由，必须人明确接受或拒绝。
 * 管理员命令先核对所属执行仍在运行、执行器身份一致；核对不了就不允许批准。
 */
import type { Job, Proposal } from "@lumio/schema";
import { approvalSummaryCard } from "../approval-summary.ts";
import { errorText, type Client } from "../api.ts";
import { clear, empty, failure, h, icon, loading, placeholder, toast } from "../dom.ts";
import { JOB_LABELS } from "../labels.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import type { Navigate } from "../navigation.ts";
import { t, translated } from "../i18n.ts";
import { dispatchSummary, isWorkProposal, pendingDispatchArgs, proposalCard } from "../proposal-card.ts";
import { actorLabel, proposalActor, proposalProject, proposalTime, unknownObject } from "../proposal-context.ts";

const STATUS: Record<Proposal["status"], string> = translated({ pending: "Pending", accepted: "Accepted", rejected: "Rejected", withdrawn: "Withdrawn" });
function title(p: Proposal): string {
  if (p.operation.op === "exec.privileged") return p.operation.args.argv.join(" ");
  const op = p.operation.args.operation;
  if (op.op === "work.task.dispatch") return t("Delegate a task");
  if (op.op === "work.plan_template.save") return op.args.name;
  return t("Handoff plan");
}

export class ApprovalsPane {
  private split = h("div", { class: "split" });
  private list = h("div", { class: "list-scroll" });
  private detail = h("section", { class: "detail-pane", "aria-live": "polite" });
  private status: Proposal["status"] = "pending";
  private proposals: Proposal[] = [];
  private selected?: string;
  private generation = 0;
  private detailGeneration = 0;
  private active = true;
  private unbindKeys: () => void;

  constructor(root: HTMLElement, private client: Client, private changed: () => void, private navigate: Navigate) {
    const seg = h("div", { class: "segmented", role: "group", "aria-label": t("Approval status") });
    for (const status of ["pending", "accepted", "rejected", "withdrawn"] as const) {
      seg.append(h("button", { type: "button", "aria-pressed": String(status === this.status), onclick: (event: Event) => {
        this.status = status; seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === event.currentTarget)));
        this.selected = undefined; this.showPlaceholder(); void this.load();
      } }, STATUS[status]));
    }
    root.append(h("header", { class: "bar approval-bar" }, h("h1", { class: "bar-title" }, t("Approvals")), seg, h("span", { class: "bar-spacer" }),
      h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => void this.load() }, icon("refresh"))), this.split);
    this.split.append(h("div", { class: "list-pane" }, this.list), this.detail);
    this.unbindKeys = listKeys(this.list, id => this.openById(id));
    this.showPlaceholder();
    void this.load();
  }

  dispose(): void { this.active = false; this.generation++; this.detailGeneration++; this.unbindKeys(); }
  liveRefresh(): void { void this.load(true); }

  private showPlaceholder(): void {
    this.detailGeneration++;
    this.split.classList.remove("has-detail");
    clear(this.detail, placeholder("approvals", t("When an agent asks to run something that needs your permission, it shows up here. Select one to see the full command and reason.")));
  }

  private async load(quiet = false): Promise<void> {
    const generation = ++this.generation;
    if (!quiet || !this.list.childElementCount) clear(this.list, loading());
    try {
      const proposals = await this.client.proposals(this.status);
      if (!this.active || generation !== this.generation) return;
      this.proposals = proposals;
      if (!proposals.length) { clear(this.list, empty(this.status === "pending" ? t("No pending requests.") : t("Nothing here."))); return; }
      clear(this.list, ...proposals.map(p => this.proposalRow(p)));
      markSelected(this.list, this.selected);
    } catch (error) {
      if (this.active && generation === this.generation) clear(this.list, failure(errorText(error), () => this.load()));
    }
  }

  private proposalRow(p: Proposal): HTMLElement {
    const dispatch = pendingDispatchArgs(p);
    const time = proposalTime(p.created, "row-meta");
    return h("div", { class: dispatch ? "row dispatch-proposal-row" : "row", title: p.id, "data-id": p.id, role: "button", tabindex: "0", onclick: () => this.openProposal(p),
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") this.openProposal(p); } },
      icon(p.operation.op === "exec.privileged" ? "terminal" : isWorkProposal(p) ? (p.operation.args.operation.op === "work.task.dispatch" ? "play" : "route") : "approvals"),
      dispatch
        ? h("div", { class: "row-main" }, dispatchSummary(p, dispatch, this.client), time)
        : h("span", { class: "row-main" }, h("span", { class: `row-title${isWorkProposal(p) ? "" : " mono"}` }, title(p)), h("span", { class: "row-sub" }, p.reason)),
      dispatch ? null : time);
  }

  private openById(id: string): void { const p = this.proposals.find(x => x.id === id); if (p) this.openProposal(p); }

  private openProposal(proposal: Proposal): void {
    const generation = ++this.detailGeneration;
    this.selected = proposal.id; markSelected(this.list, proposal.id);
    this.split.classList.add("has-detail");
    const op = proposal.operation;
    if (isWorkProposal(proposal)) {
      clear(this.detail, h("div", { class: "detail" },
        h("div", { class: "detail-crumbs" },
          h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), "data-pad-back": true, onclick: () => { this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } }, icon("back")),
          h("span", {}, title(proposal)),
          h("span", { class: `pill ${proposal.status === "pending" ? "pill-ochre" : proposal.status === "accepted" ? "pill-green" : ""}` }, STATUS[proposal.status])),
        proposalCard(proposal, { client: this.client, navigate: this.navigate, changed: () => { this.changed(); void this.load(); } }, "approvals")));
      return;
    }
    if (op.op !== "exec.privileged") return;
    const { argv, job: jobId, runtime: runtimeId } = op.args;
    const note = h("div", { role: "alert" });
    const context = h("div", {});
    const reject = h("button", { type: "button", class: "btn", "data-pad-action": "reject" }, icon("close"), t("Reject"));
    const accept = h("button", { type: "button", class: "btn btn-danger", "data-pad-action": "primary", "data-pad-hold": true }, icon("check"), t("Accept and allow"));
    let allowAccept = false, pending = false;
    const buttons = () => { reject.disabled = pending; accept.disabled = pending || !allowAccept; };
    const decide = async (yes: boolean) => {
      if (pending) return;
      pending = true; buttons(); clear(note);
      try {
        await (yes ? this.client.acceptProposal(proposal.id) : this.client.rejectProposal(proposal.id));
        toast(yes ? t("Accepted") : t("Rejected"));
        this.changed();
        if (this.active) { this.selected = undefined; this.showPlaceholder(); void this.load(); }
      } catch (error) {
        clear(note, failure(t("{0} Refresh the list to check the current state; don't submit again.", errorText(error))));
        pending = false; buttons();
      }
    };
    reject.addEventListener("click", () => void decide(false));
    accept.addEventListener("click", () => void decide(true));

    const requestedBy = h("span", { title: proposal.author }, unknownObject(proposal.author));
    const runtime = h("span", { title: runtimeId }, unknownObject(runtimeId));
    const run = h("div", { title: jobId }, unknownObject(jobId));
    const projectValue = h("dd");
    const project = h("div", { hidden: true }, h("dt", {}, t("Project")), projectValue);
    const showProject = (id?: string | null) => {
      clear(projectValue, id ? proposalProject(this.client, id) : t("No project"));
      project.hidden = false;
    };
    const meta: Array<[string, Node]> = [
      [t("Requested by"), requestedBy], [t("Requested"), proposalTime(proposal.created)],
      [t("Run"), run], [t("Runtime identity"), runtime],
    ];
    if (proposal.decided) meta.push([t("Decided"), proposalTime(proposal.decided)]);
    const runtimeName = this.client.runtimes()
      .then(devices => devices.find(device => device.actor === runtimeId)?.registration.name, () => undefined)
      .then(async name => name ?? (await proposalActor(this.client, runtimeId))?.name);
    void runtimeName.then(name => {
      if (!name) return;
      runtime.textContent = name;
      if (proposal.author === runtimeId) requestedBy.textContent = name;
    });
    if (proposal.author !== runtimeId) void proposalActor(this.client, proposal.author).then(actor => {
      if (actor) requestedBy.textContent = actorLabel(actor);
    });

    clear(this.detail, h("div", { class: "detail", title: proposal.id },
      h("div", { class: "detail-crumbs" },
        h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), "data-pad-back": true, onclick: () => { this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } }, icon("back")),
        h("span", {}, t("Run a command as administrator")),
        h("span", { class: `pill ${proposal.status === "pending" ? "pill-ochre" : proposal.status === "accepted" ? "pill-green" : ""}` }, STATUS[proposal.status])),
      h("div", { class: "detail-head" }, h("h2", { class: "inline-title" }, proposal.reason)),
      h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, t("Command"))),
        h("pre", { class: "code-block" }, argv.map(a => JSON.stringify(a)).join(" "))),
      h("dl", { class: "meta-grid section" }, ...meta.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))), project),
      context, approvalSummaryCard(this.client, proposal.id), note,
      proposal.status === "pending" && h("div", { class: "button-row section" }, accept, reject)));
    buttons();

    if (proposal.status === "pending") clear(context, loading(t("Checking the run…")));
    void (async () => {
      let job: Job;
      try {
        job = await this.client.job(jobId);
        if (job.spec.runtime !== runtimeId) throw new Error("unmatched job");
      } catch {
        if (this.active && generation === this.detailGeneration && proposal.status === "pending") {
          clear(context, failure(t("Couldn't check the run, so approval is disabled. Refresh and try again.")));
        }
        return;
      }
      if (!this.active || generation !== this.detailGeneration) return;

      const live = ["queued", "assigned", "running"].includes(job.status);
      clear(context, h("dl", { class: "meta-grid" }, h("div", {}, h("dt", {}, t("Working directory")), h("dd", { class: "mono" }, job.spec.workdir)), h("div", {}, h("dt", {}, t("Run status")), h("dd", {}, JOB_LABELS[job.status]))),
        proposal.status === "pending" && !live && h("div", { class: "notice" }, icon("alert"), h("span", {}, t("This run has already ended and can no longer be approved. Reject it, or refresh the list."))));
      allowAccept = live; buttons();

      const agent = job.spec.run.kind === "agent" ? job.spec.run.engine : undefined;
      if (agent && proposal.author === runtimeId) void runtimeName.then(name => {
        if (name) requestedBy.textContent = `${agent}@${name}`;
      });
      if (job.project !== undefined) showProject(job.project);
      const source = job.spec.source;
      const round = source && h("span", { class: "muted" }, t("Round {0}", source.round));
      if (source?.task) {
        const taskId = source.task;
        clear(run, h("div", { title: taskId }, unknownObject(taskId)), round);
        void this.client.workTask(taskId).then(({ task }) => {
          if (!this.active || generation !== this.detailGeneration) return;
          clear(run, h("button", { type: "button", class: "dispatch-task-link", title: taskId, "data-pad-action": "detail", onclick: () => this.navigate("work", taskId) }, task.title), round);
          if (job.project === undefined) showProject(task.project);
        }, () => {});
      } else if (source?.routine) {
        const routineId = source.routine;
        const routine = h("div", { title: routineId }, unknownObject(routineId));
        clear(run, routine, round);
        void this.client.executionRoutine(routineId).then(value => { routine.textContent = value.title; }, () => {});
      } else {
        clear(run, h("button", { type: "button", class: "dispatch-task-link", onclick: () => this.navigate("execution", jobId) }, t("View run")), round);
      }
    })();
  }
}
