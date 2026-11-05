/**
 * 任务的「轮到谁」（ADR 0032）：界面按它分组、显示与操作。
 * 任务没有状态和负责人；只有结局（open / done / cancelled）与轮到谁（持有者 + 原因）。
 */
import { RESPONSE_REASONS, type WorkCommandRequest, type WorkTask } from "@lumio/schema";
import { statusIcon } from "./dom.ts";
import { t, translated } from "./i18n.ts";
import { newRequestId } from "./commands.ts";

export type TurnGroup = "needs" | "todo" | "agents" | "external" | "hold" | "done" | "cancelled";
export const TURN_GROUPS: readonly TurnGroup[] = ["needs", "todo", "agents", "external", "hold", "done", "cancelled"];

export const TURN_GROUP_LABELS: Record<TurnGroup, string> = translated({
  needs: "Needs you", todo: "Your to-dos", agents: "Agents working", external: "Waiting on others", hold: "On hold", done: "Done", cancelled: "Cancelled",
});
const REASON_LABELS: Record<string, string> = translated({
  todo: "To do", answer: "Answer the question", review: "Ready for review", failed: "Run failed", working: "Working", waiting: "Waiting", on_hold: "On hold",
});

export const needsYou = (task: WorkTask) => task.outcome === "open" && task.turn.holder === "human" && (RESPONSE_REASONS as readonly string[]).includes(task.turn.reason);

export function turnGroup(task: WorkTask): TurnGroup {
  if (task.outcome !== "open") return task.outcome;
  if (task.turn.holder === "human") return needsYou(task) ? "needs" : "todo";
  if (task.turn.holder === "external") return "external";
  if (task.turn.holder === "nobody") return "hold";
  return "agents";
}

/** 组 → 图标样式（复用状态图标的形状）。 */
export function turnIcon(group: TurnGroup): SVGSVGElement {
  return statusIcon({ needs: "needs", todo: "todo", agents: "active", external: "waiting", hold: "paused", done: "done", cancelled: "cancelled" }[group]);
}

/** 一句话说明现在轮到谁，例如「轮到你 · 验收」「codex@mac 正在执行（第 3 轮）」。 */
export function turnText(task: WorkTask): string {
  const turn = task.turn;
  if (task.outcome === "done") return t("Done");
  if (task.outcome === "cancelled") return t("Cancelled");
  if (turn.holder === "human") return t("Your turn · {0}", REASON_LABELS[turn.reason] ?? turn.reason);
  if (turn.holder === "external") return turn.note ? t("Waiting on others: {0}", turn.note) : t("Waiting on others");
  if (turn.holder === "nobody") return t("On hold");
  return turn.round ? t("{0} is working (round {1})", turn.holder, turn.round) : t("{0} is working", turn.holder);
}

export const reasonLabel = (reason: string) => REASON_LABELS[reason] ?? reason;

type Base = { task: string; expected_revision: number };
const base = (task: Pick<WorkTask, "id" | "revision">): Base => ({ task: task.id, expected_revision: task.revision });

/** 交回：给自己（我自己来）、外部（必须说明在等什么）、无人（搁置）。 */
export function handCommand(task: Pick<WorkTask, "id" | "revision">, to: "human" | "external" | "nobody", note?: string, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.task.hand", args: { ...base(task), to, ...(note?.trim() ? { note: note.trim().slice(0, 200) } : {}) } } };
}
export function finishCommand(task: Pick<WorkTask, "id" | "revision">, outcome: "done" | "cancelled", requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.task.finish", args: { ...base(task), outcome } } };
}
export function reopenCommand(task: Pick<WorkTask, "id" | "revision">, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.task.reopen", args: base(task) } };
}

export type TurnAction = "mine" | "external" | "hold" | "done" | "cancel" | "reopen";
/** 当前可以做的交接与结局操作（委派是单独的按钮）。 */
export function turnActions(task: WorkTask): TurnAction[] {
  if (task.outcome !== "open") return ["reopen"];
  const actions: TurnAction[] = [];
  if (!(task.turn.holder === "human" && task.turn.reason === "todo")) actions.push("mine");
  if (task.turn.holder !== "external") actions.push("external");
  if (task.turn.holder !== "nobody") actions.push("hold");
  actions.push("done", "cancel");
  return actions;
}
export const TURN_ACTION_LABELS: Record<TurnAction, string> = translated({
  mine: "I'll handle it", external: "Waiting on others…", hold: "Put on hold", done: "Mark done", cancel: "Cancel task", reopen: "Reopen",
});
export const TURN_ACTION_ICONS: Record<TurnAction, string> = { mine: "user", external: "clock", hold: "pause", done: "check", cancel: "close", reopen: "refresh" };

/** 操作 → 命令。external 需要说明，由调用方先问。 */
export function turnActionCommand(task: WorkTask, action: TurnAction, note?: string): WorkCommandRequest {
  switch (action) {
    case "mine": return handCommand(task, "human");
    case "external": return handCommand(task, "external", note);
    case "hold": return handCommand(task, "nobody");
    case "done": return finishCommand(task, "done");
    case "cancel": return finishCommand(task, "cancelled");
    case "reopen": return reopenCommand(task);
  }
}
export const TURN_ACTION_DONE: Record<TurnAction, string> = translated({
  mine: "It's your turn now.", external: "Marked as waiting on others.", hold: "Put on hold.", done: "Task marked done.", cancel: "Task cancelled.", reopen: "Task reopened.",
});
