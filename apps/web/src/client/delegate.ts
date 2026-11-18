/**
 * 一键委派（ADR 0044，E1-4）：下一次委派给谁由 Hub 推导（next_target），
 * 不带 to 提交即按同一规则派出；换人就是显式 to，之后这个任务一直沿用。
 */
import type { WorkCommandRequest, WorkTask } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { h, icon, openMenu, toast } from "./dom.ts";
import type { Navigate } from "./navigation.ts";
import { engineTargets, newRequestId } from "./commands.ts";
import { t } from "./i18n.ts";
import { turnGroup } from "./turn.ts";

type NextTarget = NonNullable<WorkTask["next_target"]>;

/** 列表里能一键委派的条目：轮到你、普通待办、未阻塞、Hub 推导出了目标。 */
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

/** 一键委派（ADR 0044）：按 Hub 推导的目标派出；小箭头换人，之后这个任务一直交给新的 agent。 */
export function quickDelegateActions(client: Client, task: WorkTask, navigate: Navigate,
  refresh: (changed: boolean) => Promise<void>): HTMLElement | undefined {
  const next = quickDelegateTarget(task);
  if (!next) return undefined;
  const go = h("button", { type: "button", class: "btn btn-small quick-delegate", "data-pad-action": "delegate", title: t("Delegate to {0}", nextTargetText(next)), "aria-label": t("Delegate to {0}", next.target) },
    icon("play"), h("span", { class: "quick-delegate-label" }, t("Delegate")));
  const pick = h("button", { type: "button", class: "btn btn-small quick-delegate-pick", title: next.source === "plan" ? t("Set by the plan step") : t("Delegate to someone else"),
    "aria-label": t("Delegate to someone else"), disabled: next.source === "plan" }, icon("down"));
  const group = h("span", { class: "quick-delegate-group" }, go, pick);
  let requestId = newRequestId(), previous: string | undefined;
  const send = async (to?: string) => {
    if (go.disabled || !group.isConnected || group.closest("[hidden]")) return;
    if (previous !== undefined && previous !== (to ?? "")) requestId = newRequestId();
    previous = to ?? "";
    group.classList.add("is-busy"); go.disabled = pick.disabled = true;
    let changed = false;
    try {
      const result = await client.workCommand(quickDispatchCommand(task, to, requestId));
      changed = true;
      const who = result.kind === "job" ? result.target ?? to ?? next.target : to ?? next.target;
      if (result.kind === "proposal") toast(t("Waiting for your approval"));
      else if (result.kind === "job") toast(t("Dispatched to {0}", who), "ok", {
        label: t("View run"), run: () => navigate("execution", result.job.spec.id, "from-dispatch-toast"),
      });
    } catch (cause) {
      toast(errorText(cause), "error");
    }
    try { await refresh(changed); }
    finally {
      group.classList.remove("is-busy"); go.disabled = false; pick.disabled = next.source === "plan";
    }
  };
  go.addEventListener("click", () => void send());
  pick.addEventListener("click", async () => {
    try {
      const targets = engineTargets(await client.runtimes());
      if (!pick.isConnected || pick.disabled || pick.closest("[hidden]")) return;
      openMenu(pick, targets.map(x => ({ value: x.target, label: x.label, selected: x.target === next.target, icon: icon("bot") })), value => void send(value));
    } catch (cause) { toast(errorText(cause), "error"); }
  });
  return group;
}
