import { ExecutionTarget, parseAssignee } from "@lumio/schema";
import type { HubStore } from "./store.ts";
import { HubError } from "./errors.ts";

export function executionTargets(store: HubStore, now = new Date()): ExecutionTarget[] {
  return ExecutionTarget.array().parse(store.runtimes(now).flatMap(runtime => runtime.registration.engines.map(engine => ({
    target: `${engine.name}@${runtime.registration.name}`, runtime: runtime.registration.name,
    engine: engine.name, version: engine.version, online: runtime.online,
  }))));
}
export function validateTarget(store: HubStore, localRuntime: string | undefined, target: string, now = new Date()): ExecutionTarget {
  const targets = executionTargets(store, now), parsed = parseAssignee(target);
  const found = parsed === "human" ? undefined : targets.find(value => value.runtime === (parsed.device ?? localRuntime) && value.engine === parsed.agent);
  if (!found) throw new HubError("INVALID", { key: "target.invalid", args: [target, targets.map(value => value.target).join(", ")] });
  return found;
}
