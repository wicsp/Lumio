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

const STATUS: Record<Proposal["status"], string> = { pending: "待审批", accepted: "已接受", rejected: "已拒绝" };
const title = (p: Proposal) => p.operation.op === "exec.privileged" ? p.operation.args.argv.join(" ") : p.operation.op;

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

  constructor(root: HTMLElement, private client: Client, private changed: () => void) {
    const seg = h("div", { class: "segmented", role: "group", "aria-label": "审批状态" });
    for (const status of ["pending", "accepted", "rejected"] as const) {
      seg.append(h("button", { type: "button", "aria-pressed": String(status === this.status), onclick: (event: Event) => {
        this.status = status; seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === event.currentTarget)));
        this.selected = undefined; this.showPlaceholder(); void this.load();
      } }, STATUS[status]));
    }
    root.append(h("header", { class: "bar" }, h("h1", { class: "bar-title" }, "审批"), seg, h("span", { class: "bar-spacer" }),
      h("button", { type: "button", class: "icon-btn", title: "刷新", "aria-label": "刷新", onclick: () => void this.load() }, icon("refresh"))), this.split);
    this.split.append(h("div", { class: "list-pane" }, this.list), this.detail);
    this.unbindKeys = listKeys(this.list, id => this.openById(id));
    this.showPlaceholder();
    void this.load();
  }

  dispose(): void { this.active = false; this.generation++; this.detailGeneration++; this.unbindKeys(); }

  private showPlaceholder(): void {
    this.split.classList.remove("has-detail");
    clear(this.detail, placeholder("approvals", "agent 申请执行需要你授权的操作时会出现在这里。选择一项查看完整命令与理由。"));
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    clear(this.list, loading());
    try {
      const proposals = await this.client.proposals(this.status);
      if (!this.active || generation !== this.generation) return;
      this.proposals = proposals;
      if (!proposals.length) { clear(this.list, empty(this.status === "pending" ? "没有待审批的申请。" : "没有记录。")); return; }
      clear(this.list, ...proposals.map(p => h("div", { class: "row", "data-id": p.id, role: "button", tabindex: "0", onclick: () => this.openProposal(p),
        onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") this.openProposal(p); } },
        icon(p.operation.op === "exec.privileged" ? "terminal" : "approvals"),
        h("span", { class: "row-main" }, h("span", { class: "row-title mono" }, title(p)), h("span", { class: "row-sub" }, p.reason)),
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
    const note = h("div", { role: "alert" });
    const context = h("div", {});
    const reject = h("button", { type: "button", class: "btn" }, icon("close"), "拒绝");
    const accept = h("button", { type: "button", class: "btn btn-danger" }, icon("check"), "接受并允许执行");
    let allowAccept = op.op !== "exec.privileged", pending = false;
    const buttons = () => { reject.disabled = pending; accept.disabled = pending || !allowAccept; };
    const decide = async (yes: boolean) => {
      if (pending) return;
      pending = true; buttons(); clear(note);
      try {
        await (yes ? this.client.acceptProposal(proposal.id) : this.client.rejectProposal(proposal.id));
        toast(yes ? "已接受" : "已拒绝");
        this.changed();
        if (this.active) { this.selected = undefined; this.showPlaceholder(); void this.load(); }
      } catch (error) {
        clear(note, failure(`${errorText(error)}。请刷新列表确认当前状态，不要重复提交。`));
        pending = false; buttons();
      }
    };
    reject.addEventListener("click", () => void decide(false));
    accept.addEventListener("click", () => void decide(true));

    const meta: Array<[string, Node | string]> = [["提交者", proposal.author], ["提交时间", formatTime(proposal.created)]];
    if (op.op === "exec.privileged") meta.push(["所属执行", h("span", { class: "mono" }, op.args.job)], ["执行器身份", op.args.runtime]);
    if (proposal.decided) meta.push(["决定时间", formatTime(proposal.decided)]);

    clear(this.detail, h("div", { class: "detail" },
      h("div", { class: "detail-crumbs" },
        h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": "返回列表", onclick: () => { this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } }, icon("back")),
        h("span", {}, op.op === "exec.privileged" ? "以管理员权限执行命令" : op.op),
        h("span", { class: `pill ${proposal.status === "pending" ? "pill-ochre" : proposal.status === "accepted" ? "pill-green" : ""}` }, STATUS[proposal.status])),
      h("div", { class: "detail-head" }, h("h2", { class: "inline-title" }, proposal.reason)),
      h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, op.op === "exec.privileged" ? "命令" : "参数")),
        h("pre", { class: "code-block" }, op.op === "exec.privileged" ? op.args.argv.map(a => JSON.stringify(a)).join(" ") : JSON.stringify(op.args, null, 2))),
      h("dl", { class: "meta-grid section" }, ...meta.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
      context, note,
      proposal.status === "pending" && h("div", { class: "button-row section" }, accept, reject)));
    buttons();

    if (op.op !== "exec.privileged" || proposal.status !== "pending") return;
    allowAccept = false; buttons();
    clear(context, loading("正在核对所属执行…"));
    void (async () => {
      try {
        const job = await this.client.job(op.args.job);
        if (!this.active || generation !== this.detailGeneration) return;
        if (job.spec.runtime !== op.args.runtime) throw new Error("unmatched job");
        const live = ["queued", "assigned", "running"].includes(job.status);
        clear(context, h("dl", { class: "meta-grid" }, h("div", {}, h("dt", {}, "工作目录"), h("dd", { class: "mono" }, job.spec.workdir)), h("div", {}, h("dt", {}, "执行状态"), h("dd", {}, JOB_LABELS[job.status]))),
          !live && h("div", { class: "notice" }, icon("alert"), h("span", {}, "这次执行已经结束，不能再批准。可以拒绝，或刷新列表核对。")));
        allowAccept = live; buttons();
      } catch {
        if (!this.active || generation !== this.detailGeneration) return;
        clear(context, failure("暂时无法核对所属执行，已停用批准。请刷新后重试。"));
        allowAccept = false; buttons();
      }
    })();
  }
}
