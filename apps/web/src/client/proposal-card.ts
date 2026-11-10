/**
 * agent 的委派、交接计划与计划模板提议（ADR 0031 第 2 节、0032、0049）：一张卡片说清楚「谁想让谁做什么」，一键批准或拒绝。
 * 计划与模板完整列出每一步的权限与钩子命令（ADR 0049：含钩子或 full 权限的计划必须完整展示后由人批准）。
 * 批准后 Hub 以提议作者的身份、按提议时看到的任务版本执行；任务在这之后被改过时，Hub 拒绝执行并说明。
 */
import type { Proposal, WorkCommandProposal } from "@lumio/schema";
import { errorText, isConflict, type Client } from "./api.ts";
import { formatTime } from "./commands.ts";
import { clear, failure, h, icon } from "./dom.ts";
import { ago } from "./format.ts";
import { t } from "./i18n.ts";
import { hookText, permissionSummary, planRows } from "./plan.ts";
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
  if (op.op === "work.plan_template.save") return op.args.template ? t("{0} proposes updating the plan template “{1}”", author, op.args.name) : t("{0} proposes saving a plan template “{1}”", author, op.args.name);
  if (op.op === "work.task.dispatch") return op.args.to ? t("{0} wants to delegate “{1}” to {2}", author, task, op.args.to) : t("{0} wants to delegate “{1}”", author, task);
  return op.args.plan ? t("{0} proposes a handoff plan for “{1}”", author, task) : t("{0} proposes removing the plan from “{1}”", author, task);
}

/** 提议的具体内容：委派附带的评论，或计划的每一步。 */
export function proposalBody(proposal: WorkProposal): HTMLElement | null {
  const op = proposal.operation.args.operation;
  if (op.op === "work.task.dispatch") return op.args.comment ? h("p", { class: "attn-summary" }, op.args.comment) : null;
  if (!op.args.plan) return null;
  const plan = op.args.plan, rows = planRows(plan.stages), parallel = new Set((rows ?? []).filter(row => row.length > 1).flat());
  const risky = plan.stages.some(stage => stage.kind === "agent" && (stage.access === "full" || stage.hooks || stage.secrets?.length));
  return h("div", { class: "proposal-plan-wrap" },
    h("ol", { class: "proposal-plan" }, ...plan.stages.map(stage => h("li", {},
      icon(stage.kind === "agent" ? "bot" : "flag"),
      h("span", {}, stage.kind === "agent" ? t("{0}: {1}", stage.agent, stage.instruction.split("\n")[0]!.slice(0, 120)) : t("Checkpoint: {0}", stage.prompt),
        parallel.has(stage.id) ? h("span", { class: "muted" }, t(" · in parallel")) : null,
        !rows && stage.after ? h("span", { class: "muted" }, t(" · after {0}", stage.after.join(", ") || t("nothing"))) : null,
        stage.kind === "agent" && stage.back_to ? h("span", { class: "muted" }, t(" · may send back to {0}", stage.back_to)) : null,
        stage.kind === "agent" ? h("span", { class: `proposal-perm${stage.access === "full" ? " is-risky" : ""}` }, permissionSummary(stage)) : null,
        ...(stage.kind === "agent" && stage.hooks ? [
          stage.hooks.before ? h("code", { class: "proposal-hook" }, t("before: {0}", hookText(stage.hooks.before))) : null,
          stage.hooks.after ? h("code", { class: "proposal-hook" }, t("after: {0}", hookText(stage.hooks.after))) : null] : []))))),
    plan.finish === "auto" ? h("p", { class: "muted" }, t("When the plan ends, the task is marked done automatically.")) : null,
    risky ? h("p", { class: "proposal-warn" }, icon("alert"), t("This plan runs commands or grants extra access. Check every step before approving.")) : null);
}

export interface ProposalContext { client: Client; navigate: Navigate; changed(): void }

/** 今日与审批页共用的卡片。 */
export function proposalCard(proposal: WorkProposal, ctx: ProposalContext): HTMLElement {
  const args = proposal.operation.args.operation.args;
  // 计划模板提议没有任务（ADR 0049 第 6 节）：标题不是跳转按钮。
  const task = "task" in args ? args.task : undefined;
  const heading = task
    ? h("button", { type: "button", class: "attn-title", onclick: () => ctx.navigate("work", task) }, proposal.reason)
    : h("p", { class: "attn-title" }, proposal.reason);
  void Promise.all([actorName(ctx.client, proposal.author), task ? ctx.client.workTask(task).then(detail => detail.task.title, () => proposal.reason) : Promise.resolve("")])
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
      clear(card, h("p", { class: "attn-done" }, icon("check"), yes ? (task ? t("Approved. Lumio is carrying it out.") : t("Approved. The template is saved.")) : t("Rejected.")));
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
