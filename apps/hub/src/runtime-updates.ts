import { createHash } from "node:crypto";
import { ExecutionRuntimeUpdateCommandRequest, type RuntimeInfo } from "@lumio/schema";
import { ExecutionError } from "@lumio/execution";
import type { HubStore, Identity } from "./store.ts";
import type { Notifications } from "./notifications.ts";
import { HubError } from "./errors.ts";

export function updateRuntime(store: HubStore, identity: Identity, body: unknown, now: Date): Response {
  const parsed = ExecutionRuntimeUpdateCommandRequest.safeParse(body);
  const op = parsed.success ? parsed.data.operation.op : "execution.runtime.update";
  let result = "applied";
  try {
    if (identity.actor.role !== "human") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
    if (!parsed.success) throw new HubError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
    const runtime = store.runtimes(now).find(value => value.registration.name === parsed.data.operation.args.runtime);
    if (!runtime) throw new HubError("NOT_FOUND", { key: "runtimes.runtime_is_not_registered", args: [] });
    return Response.json(store.runtimeUpdates.command(runtime, identity.actor.id, parsed.data));
  } catch (cause) {
    if (cause instanceof ExecutionError) { result = cause.code; throw new HubError(cause.code, cause.params); }
    result = cause instanceof HubError ? cause.code : "INTERNAL"; throw cause;
  } finally { store.audit(identity, op, identity.actor.role === "human" ? "allow" : "deny", undefined, result); }
}
/** Stable notification IDs deduplicate unchanged failure reports across heartbeats and Hub restarts. */
export function notifyRuntimeUpdate(store: HubStore, notifications: Notifications, runtime: RuntimeInfo, now: Date): void {
  const report = runtime.update?.report;
  if (!report || report.target !== runtime.update?.desired || runtime.update?.hold) return;
  if (!["failed", "blocked"].includes(report.state) && !(report.state === "draining" && now.getTime() - Date.parse(report.since) >= 2 * 60 * 60 * 1000)) return;
  for (const owner of store.actors().filter(actor => actor.role === "human")) notifications.notifyWorkbench({
    id: createHash("sha256").update(JSON.stringify(["runtime-update", owner.id, runtime.actor, report.target, report.state, report.since])).digest("hex"),
    owner: owner.id, title: `Lumio: ${runtime.registration.name} — ${report.state}`, path: "#settings", created: now.toISOString(),
  });
}
