/**
 * 一键委派（ADR 0044，E1-4）：下一次委派给谁由 Hub 推导（next_target），
 * 不带 to 提交即按同一规则派出；换人就是显式 to，之后这个任务一直沿用。
 */
import type { WorkCommandRequest, WorkTask } from "@lumio/schema";
import { newRequestId } from "./commands.ts";
import { t } from "./i18n.ts";
import { turnGroup } from "./turn.ts";

type NextTarget = NonNullable<WorkTask["next_target"]>;

/** Today 待办上能一键委派的条目：轮到你、普通待办、未阻塞、Hub 推导出了目标。 */
export function quickDelegateTarget(task: WorkTask): NextTarget | undefined {
  if (turnGroup(task) !== "todo" || task.turn.reason !== "todo") return undefined;
  return task.next_target;
}

/** 不带 to：交给 next_target；带 to：人手动换人（计划步骤固定时不能换）。 */
export function quickDispatchCommand(task: Pick<WorkTask, "id" | "revision">, to?: string, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.task.dispatch", args: { task: task.id, ...(to ? { to } : {}), expected_revision: task.revision } } };
}

/** 目标来源的简短说明，用在按钮提示与任务详情。 */
export function targetSourceLabel(source: NextTarget["source"] | "explicit"): string {
  return { plan: t("plan step"), last_round: t("last round"), project: t("project default"), explicit: t("chosen by you") }[source];
}

export function nextTargetText(next: NextTarget): string {
  return t("{0} ({1})", next.target, targetSourceLabel(next.source));
}
