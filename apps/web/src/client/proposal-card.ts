/**
 * agent 的委派与交接计划提议（ADR 0031 第 2 节、0032）：一张卡片说清楚「谁想让谁做什么」，一键批准或拒绝。
 * 批准后 Hub 以提议作者的身份、按提议时看到的任务版本执行；任务在这之后被改过时，Hub 拒绝执行并说明。
 */
import type { Proposal, WorkCommandProposal } from "@lumio/schema";
import { errorText, isConflict, type Client } from "./api.ts";
import { formatTime } from "./commands.ts";
import { clear, failure, h, icon } from "./dom.ts";
import { ago } from "./format.ts";
import { t } from "./i18n.ts";
import type { Navigate } from "./navigation.ts";

export type WorkProposal = Proposal & { operation: WorkCommandProposal };
export const isWorkProposal = (proposal: Proposal): proposal is WorkProposal => proposal.operation.op === "work.command";

let names: Promise<Map<string, string>> | undefined;
function actorName(client: Client, id: string): Promise<string> {
  names ??= client.actors().then(list => new Map(list.map(actor => [actor.id, actor.name.startsWith("work-system-") ? "Lumio" : actor.name])), () => { names = undefined; return new Map<string, string>(); });
  return names.then(map => map.get(id) ?? t("An agent"));
}

/** 一句话标题（审批列表、今日卡片）。 */
export function proposalTitle(proposal: WorkProposal, author: string, task: string): string {
  const op = proposal.operation.args.operation;
  if (op.op === "work.task.dispatch") return op.args.to ? t("{0} wants to delegate “{1}” to {2}", author, task, op.args.to) : t("{0} wants to delegate “{1}”", author, task);
  return op.args.plan ? t("{0} proposes a handoff plan for “{1}”", author, task) : t("{0} proposes removing the plan from “{1}”", author, task);
}

/** 提议的具体内容：委派附带的评论，或计划的每一步。 */
export function proposalBody(proposal: WorkProposal): HTMLElement | null {
  const op = proposal.operation.args.operation;
  if (op.op === "work.task.dispatch") return op.args.comment ? h("p", { class: "attn-summary" }, op.args.comment) : null;
  if (!op.args.plan) return null;
  return h("ol", { class: "proposal-plan" }, ...op.args.plan.stages.map(stage => h("li", {},
    icon(stage.kind === "agent" ? "bot" : "flag"),
    h("span", {}, stage.kind === "agent" ? t("{0}: {1}", stage.agent, stage.instruction.split("\n")[0]!.slice(0, 120)) : t("Checkpoint: {0}", stage.prompt),
      stage.kind === "agent" && stage.back_to ? h("span", { class: "muted" }, t(" · may send back to {0}", stage.back_to)) : null))));
}

export interface ProposalContext { client: Client; navigate: Navigate; changed(): void }

/** 今日与审批页共用的卡片。 */
export function proposalCard(proposal: WorkProposal, ctx: ProposalContext): HTMLElement {
  const args = proposal.operation.args.operation.args;
  // 保存计划模板的提议（ADR 0049）由 H1-7 做专门的预览卡片；在那之前只显示理由。
  if (!("task" in args)) return h("article", { class: "attn attn-ochre" }, proposal.reason);
  const task = args.task;
  const heading = h("button", { type: "button", class: "attn-title", onclick: () => ctx.navigate("work", task) }, proposal.reason);
  void Promise.all([actorName(ctx.client, proposal.author), ctx.client.workTask(task).then(detail => detail.task.title, () => proposal.reason)])
    .then(([author, title]) => { heading.textContent = proposalTitle(proposal, author, title); });
  const card = h("article", { class: `attn ${proposal.status === "pending" ? "attn-ochre" : "attn-done-state"}` });
  const error = h("div", { role: "alert" });
  const approve = h("button", { type: "button", class: "btn btn-primary btn-small" }, icon("check"), t("Approve"));
  const reject = h("button", { type: "button", class: "btn btn-small" }, icon("close"), t("Reject"));
  let busy = false;
  const decide = async (yes: boolean) => {
    if (busy) return;
    busy = true; approve.disabled = reject.disabled = true; clear(error);
    try {
      await (yes ? ctx.client.acceptProposal(proposal.id) : ctx.client.rejectProposal(proposal.id));
      clear(card, h("p", { class: "attn-done" }, icon("check"), yes ? t("Approved. Lumio is carrying it out.") : t("Rejected.")));
      card.classList.add("is-done");
      ctx.changed();
    } catch (cause) {
      clear(error, failure(isConflict(cause) ? t("The task changed after this was proposed, so it can't be applied. Reject it and ask again if needed.") : errorText(cause)));
      busy = false; approve.disabled = reject.disabled = false;
    }
  };
  approve.addEventListener("click", () => void decide(true));
  reject.addEventListener("click", () => void decide(false));
  card.append(
    h("header", { class: "attn-head" },
      h("span", { class: "attn-icon" }, icon("approvals")),
      h("div", { class: "attn-heading" },
        h("p", { class: "attn-kind" }, proposal.status === "pending" ? t("Waiting for your approval") : proposal.status === "accepted" ? t("Approved") : proposal.status === "rejected" ? t("Rejected") : t("Withdrawn")),
        heading,
        h("p", { class: "attn-meta", title: formatTime(proposal.created) }, ago(proposal.created)))),
    ...[proposalBody(proposal)].filter((node): node is HTMLElement => node !== null),
    proposal.status === "pending" ? h("div", { class: "attn-actions" }, approve, reject)
      : h("p", { class: "muted" }, proposal.status === "accepted" ? t("Approved") : proposal.status === "rejected" ? t("Rejected")
        : proposal.superseded_by ? t("Withdrawn: replaced by a newer proposal from the same agent.") : t("Withdrawn by the agent.")),
    error);
  return card;
}
