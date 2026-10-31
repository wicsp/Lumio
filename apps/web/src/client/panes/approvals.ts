/**
 * 审批（ADR 0026）：待审批与历史；接受/拒绝前完整显示操作、命令参数、Job 与理由，必须人确认。
 */
import type { Proposal } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { JOB_LABELS } from "../labels.ts";
import { formatTime } from "../commands.ts";
import { clear, empty, failure, h, icon, loading, openDialog } from "../dom.ts";

const STATUS: Record<Proposal["status"], string> = { pending: "待审批", accepted: "已接受", rejected: "已拒绝" };

function describe(proposal: Proposal): HTMLElement {
  const op = proposal.operation;
  const rows: Array<[string, Node | string]> = [["理由", proposal.reason], ["提交者", proposal.author], ["提交时间", formatTime(proposal.created)]];
  if (op.op === "exec.privileged") {
    rows.unshift(["操作", "以管理员权限执行命令"], ["命令", h("pre", { class: "argv" }, op.args.argv.map((a) => JSON.stringify(a)).join(" "))],
      ["所属执行", op.args.job], ["执行器身份", op.args.runtime]);
  } else rows.unshift(["操作", op.op], ["参数", h("pre", {}, JSON.stringify(op.args, null, 2))]);
  if (proposal.decided) rows.push(["决定时间", formatTime(proposal.decided)]);
  return h("dl", { class: "detail-list" }, ...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}

export class ApprovalsPane {
  private generation=0;
  private active=true;
  dispose():void{this.active=false;this.generation++;}
  private list = h("div", { class: "list" });
  private status: Proposal["status"] = "pending";

  constructor(root: HTMLElement, private client: Client) {
    const tabs = h("div", { class: "tabs", role: "group", "aria-label": "审批状态" });
    for (const status of ["pending", "accepted", "rejected"] as const) {
      tabs.append(h("button", { type: "button", class: "btn btn-small", "aria-pressed": String(status === this.status), onclick: (e: Event) => {
        this.status = status; tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); void this.load();
      } }, STATUS[status]));
    }
    root.append(h("header", { class: "pane-head" }, h("h1", {}, "审批"), tabs,
      h("button", { type: "button", class: "btn btn-ghost", "aria-label": "刷新", onclick: () => this.load() }, icon("refresh"))), this.list);
    void this.load();
  }

  private async load(): Promise<void> {
    const generation=++this.generation;
    clear(this.list, loading());
    try {
      const proposals = await this.client.proposals(this.status);
      if(!this.active||generation!==this.generation)return;
      if (!proposals.length) return clear(this.list, empty(this.status === "pending" ? "没有待审批的申请" : "没有记录"));
      clear(this.list, ...proposals.map((p) => h("article", { class: "row" },
        h("div", { class: "row-main" }, h("strong", {}, p.operation.op === "exec.privileged" ? p.operation.args.argv.join(" ") : p.operation.op),
          h("span", { class: "muted" }, `${STATUS[p.status]} · ${formatTime(p.created)}`)),
        h("button", { type: "button", class: "btn btn-small", onclick: () => this.open(p) }, "查看"))));
    } catch (error) { if(this.active&&generation===this.generation)clear(this.list, failure(errorText(error), () => this.load())); }
  }

  private async open(proposal: Proposal): Promise<void> {
    const note = h("p", { class: "state state-error", role: "alert", hidden: true });
    let pending=false;
    let allowAccept=proposal.operation.op!=="exec.privileged";
    const decide = async (accept: boolean, button: HTMLButtonElement) => {
      if(pending)return;pending=true;dialog.querySelectorAll<HTMLButtonElement>(".dialog-foot button").forEach(control=>control.disabled=true);
      try { await (accept ? this.client.acceptProposal(proposal.id) : this.client.rejectProposal(proposal.id)); dialog.close(); void this.load(); }
      catch (error) { note.textContent = `${errorText(error)}。请刷新列表确认当前状态，不要重复提交。`; note.hidden = false; dialog.querySelectorAll<HTMLButtonElement>(".dialog-foot button").forEach(control=>control.disabled=control.classList.contains("btn-danger")&&!allowAccept);pending=false; }
    };
    const actions = proposal.status === "pending" ? [
      h("button", { type: "button", class: "btn", onclick: (e: Event) => decide(false, e.currentTarget as HTMLButtonElement) }, "拒绝"),
      h("button", { type: "button", class: "btn btn-danger", onclick: (e: Event) => decide(true, e.currentTarget as HTMLButtonElement) }, "接受并允许执行"),
    ] : [];
    const context=h("div",{},loading("正在核对执行上下文…"));
    const dialog = openDialog("审批详情", h("div", {}, describe(proposal),context,note), actions);
    if(proposal.operation.op!=="exec.privileged"){clear(context);return;}
    dialog.querySelectorAll<HTMLButtonElement>(".dialog-foot button").forEach(button=>button.disabled=true);
    try{
      const job=await this.client.job(proposal.operation.args.job);
      if(!this.active||!dialog.isConnected)return;
      if(job.spec.runtime!==proposal.operation.args.runtime)throw new Error("unmatched job");
      clear(context,h("dl",{class:"detail-list"},h("dt",{},"工作目录"),h("dd",{},job.spec.workdir),h("dt",{},"当前执行状态"),h("dd",{},JOB_LABELS[job.status])));
      const live=["queued","assigned","running"].includes(job.status);allowAccept=live;
      dialog.querySelectorAll<HTMLButtonElement>(".dialog-foot button").forEach(button=>button.disabled=!live&&button.classList.contains("btn-danger"));
      if(!live){note.textContent="这轮执行已经结束，不能再批准。可以拒绝或刷新列表核对。";note.hidden=false;}
    }catch{
      if(!this.active||!dialog.isConnected)return;clear(context,failure("暂时无法核对所属执行，已停用批准。请关闭后刷新列表重试。"));
      dialog.querySelector<HTMLButtonElement>(".dialog-foot .btn:not(.btn-danger)")?.removeAttribute("disabled");
    }
  }
}
