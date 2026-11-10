import { ExecutionTarget, parseAssignee, DISPATCH_TARGET_SOURCES, type AgentRun, type PlanStage, type RuntimeInfo } from "@lumio/schema";
import type { HubStore } from "./store.ts";
import { PlanDispatchUnavailable } from "@lumio/work";
import { HubError } from "./errors.ts";

export function executionTargets(store: HubStore, now = new Date()): ExecutionTarget[] {
  return ExecutionTarget.array().parse(store.runtimes(now).flatMap(runtime => runtime.registration.engines.map(engine => ({
    target: `${engine.name}@${runtime.registration.name}`, runtime: runtime.registration.name,
    engine: engine.name, version: engine.version, online: runtime.online,
  }))));
}
export function validateTarget(store: HubStore, localRuntime: string | undefined, target: string, now = new Date(), source?: (typeof DISPATCH_TARGET_SOURCES)[number]): ExecutionTarget {
  const targets = executionTargets(store, now), parsed = parseAssignee(target);
  const found = parsed === "human" ? undefined : targets.find(value => value.runtime === (parsed.device ?? localRuntime) && value.engine === parsed.agent);
  if (!found) throw new HubError("INVALID", { key: source === "project" ? "target.invalid_project_default" : "target.invalid", args: [target, targets.map(value => value.target).join(", ")] });
  return found;
}

export type AgentStage = Extract<PlanStage, { kind: "agent" }>;

export function stageDispatchOptions(stage: AgentStage, runtime: RuntimeInfo, engine: RuntimeInfo["registration"]["engines"][number]): Pick<AgentRun, "permissions" | "hooks"> {
  const { access = "write", git = false, secrets, hooks } = stage;
  const features = runtime.registration.features ?? [];
  const target = `${engine.name}@${runtime.registration.name}`;
  if (!runtime.online) throw new PlanDispatchUnavailable({ key: "target.stage_offline", args: [target] });
  if ((access !== "write" || git || secrets?.length) && !features.includes("stage_permissions")) {
    throw new PlanDispatchUnavailable({ key: "target.stage_permissions_unsupported", args: [target] });
  }
  if (engine.name === "codex" && git && access !== "full" && engine.version !== "0.166.0") {
    throw new PlanDispatchUnavailable({ key: "target.stage_git_version", args: [target, engine.version] });
  }
  if ((hooks?.before || hooks?.after) && !features.includes("hooks")) {
    throw new PlanDispatchUnavailable({ key: "target.stage_hooks_unsupported", args: [target] });
  }
  return {
    ...(features.includes("stage_permissions") ? { permissions: { access, git, ...(secrets?.length ? { secrets } : {}) } } : {}),
    ...(hooks?.before || hooks?.after ? { hooks } : {}),
  };
}
