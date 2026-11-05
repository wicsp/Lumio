/**
 * 审批（ADR 0026）：待审批与历史。决定前完整显示操作、命令参数、所属执行与理由，必须人明确接受或拒绝。
 * 管理员命令先核对所属执行仍在运行、执行器身份一致；核对不了就不允许批准。
 */
import type { Proposal } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { formatTime } from "../commands.ts";
import { clear, empty, failure, h, icon, loading, placeholder, toast } from "../dom.ts";
import { ago } from "../format.ts";
import { JOB_LABELS } from "../labels.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import type { Navigate } from "../navigation.ts";
import { t, translated } from "../i18n.ts";
import { isWorkProposal, proposalCard } from "../proposal-card.ts";

const STATUS: Record<Proposal["status"], string> = translated({ pending: "Pending", accepted: "Accepted", rejected: "Rejected", withdrawn: "Withdrawn" });
const title = (p: Proposal) => p.operation.op === "exec.privileged" ? p.operation.args.argv.join(" ")
  : isWorkProposal(p) ? (p.operation.args.operation.op === "work.task.dispatch" ? t("Delegate a task") : t("Handoff plan")) : p.operation.op;

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
    root.append(h("header", { class: "bar" }, h("h1", { class: "bar-title" }, t("Approvals")), seg, h("span", { class: "bar-spacer" }),
      h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => void this.load() }, icon("refresh"))), this.split);
    this.split.append(h("div", { class: "list-pane" }, this.list), this.detail);
    this.unbindKeys = listKeys(this.list, id => this.openById(id));
    this.showPlaceholder();
    void this.load();
  }

  dispose(): void { this.active = false; this.generation++; this.detailGeneration++; this.unbindKeys(); }
  liveRefresh(): void { void this.load(true); }

  private showPlaceholder(): void {
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
      clear(this.list, ...proposals.map(p => h("div", { class: "row", "data-id": p.id, role: "button", tabindex: "0", onclick: () => this.openProposal(p),
        onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") this.openProposal(p); } },
        icon(p.operation.op === "exec.privileged" ? "terminal" : isWorkProposal(p) ? (p.operation.args.operation.op === "work.task.dispatch" ? "play" : "route") : "approvals"),
        h("span", { class: "row-main" }, h("span", { class: `row-title${isWorkProposal(p) ? "" : " mono"}` }, title(p)), h("span", { class: "row-sub" }, p.reason)),
        h("span", { class: "row-meta", title: formatTime(p.created) }, ago(p.created)))));
      markSelected(this.list, this.selected);
    } catch (error) {
      if (this.active && generation === this.generation) clear(this.list, failure(errorText(error), () => this.load()));
    }
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
          h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), onclick: () => { this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } }, icon("back")),
          h("span", {}, title(proposal)),
          h("span", { class: `pill ${proposal.status === "pending" ? "pill-ochre" : proposal.status === "accepted" ? "pill-green" : ""}` }, STATUS[proposal.status])),
        proposalCard(proposal, { client: this.client, navigate: this.navigate, changed: () => { this.changed(); void this.load(); } })));
      return;
    }
    const note = h("div", { role: "alert" });
    const context = h("div", {});
    const reject = h("button", { type: "button", class: "btn" }, icon("close"), t("Reject"));
    const accept = h("button", { type: "button", class: "btn btn-danger" }, icon("check"), t("Accept and allow"));
    let allowAccept = op.op !== "exec.privileged", pending = false;
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

    const meta: Array<[string, Node | string]> = [[t("Requested by"), proposal.author], [t("Requested"), formatTime(proposal.created)]];
    if (op.op === "exec.privileged") meta.push([t("Run"), h("span", { class: "mono" }, op.args.job)], [t("Runtime identity"), op.args.runtime]);
    if (proposal.decided) meta.push([t("Decided"), formatTime(proposal.decided)]);

    clear(this.detail, h("div", { class: "detail" },
      h("div", { class: "detail-crumbs" },
        h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), onclick: () => { this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } }, icon("back")),
        h("span", {}, op.op === "exec.privileged" ? t("Run a command as administrator") : op.op),
        h("span", { class: `pill ${proposal.status === "pending" ? "pill-ochre" : proposal.status === "accepted" ? "pill-green" : ""}` }, STATUS[proposal.status])),
      h("div", { class: "detail-head" }, h("h2", { class: "inline-title" }, proposal.reason)),
      h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, op.op === "exec.privileged" ? t("Command") : t("Arguments"))),
        h("pre", { class: "code-block" }, op.op === "exec.privileged" ? op.args.argv.map(a => JSON.stringify(a)).join(" ") : JSON.stringify(op.args, null, 2))),
      h("dl", { class: "meta-grid section" }, ...meta.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
      context, note,
      proposal.status === "pending" && h("div", { class: "button-row section" }, accept, reject)));
    buttons();

    if (op.op !== "exec.privileged" || proposal.status !== "pending") return;
    allowAccept = false; buttons();
    clear(context, loading(t("Checking the run…")));
    void (async () => {
      try {
        const job = await this.client.job(op.args.job);
        if (!this.active || generation !== this.detailGeneration) return;
        if (job.spec.runtime !== op.args.runtime) throw new Error("unmatched job");
        const live = ["queued", "assigned", "running"].includes(job.status);
        clear(context, h("dl", { class: "meta-grid" }, h("div", {}, h("dt", {}, t("Working directory")), h("dd", { class: "mono" }, job.spec.workdir)), h("div", {}, h("dt", {}, t("Run status")), h("dd", {}, JOB_LABELS[job.status]))),
          !live && h("div", { class: "notice" }, icon("alert"), h("span", {}, t("This run has already ended and can no longer be approved. Reject it, or refresh the list."))));
        allowAccept = live; buttons();
      } catch {
        if (!this.active || generation !== this.detailGeneration) return;
        clear(context, failure(t("Couldn't check the run, so approval is disabled. Refresh and try again.")));
        allowAccept = false; buttons();
      }
    })();
  }
}
