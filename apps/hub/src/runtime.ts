import { JobResult, RuntimeAck, RuntimeHeartbeat, RuntimeInfo, RuntimeRegistration, RuntimeSync, type Job } from "@lumio/schema";
import { Jobs, type RoutineHooks } from "./jobs.ts";
import type { authorize } from "./authorize.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";

export async function handleRuntime(request: Request, operation: "runtime.register" | "runtime.sync" | "runtime.ack" | "runtime.results" | "runtimes",
  identity: Identity, store: HubStore, decide: typeof authorize, now: Date, routines?: RoutineHooks,
  onResult?: (job: Job) => void): Promise<Response> {
  const decision = decide(identity.actor, { operation });
  let execution = "applied";
  try {
    if (decision.result !== "allow") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, {
      reason: decision.result === "deny" ? decision.reason : "Approval required",
    });
    if (operation === "runtimes") return Response.json(RuntimeInfo.array().parse(store.runtimes(now)));
    let body: unknown;
    try { body = await request.json(); } catch { throw new HubError("INVALID", { key: "runtime.request_body_must_be_json", args: [] }); }
    if (operation === "runtime.register") {
      const registration = RuntimeRegistration.safeParse(body);
      if (!registration.success) throw new HubError("INVALID", { key: "runtime.invalid_runtime_registration", args: [] });
      return Response.json(store.registerRuntime(identity.actor.id, registration.data, now));
    }
    const jobs = new Jobs(store, routines);
    if (operation === "runtime.ack") {
      const ack = RuntimeAck.safeParse(body);
      if (!ack.success) throw new HubError("INVALID", { key: "runtime.invalid_job_acknowledgement", args: [] });
      jobs.ack(identity.actor.id, ack.data.accepted, now);
      return Response.json(ack.data);
    }
    if (operation === "runtime.results") {
      const result = JobResult.safeParse(body);
      if (!result.success) throw new HubError("INVALID", { key: "runtime.invalid_job_result", args: [] });
      const requested = result.data.permission;
      if (requested && (result.data.status !== "waiting_for_human" || requested.access === "read" || requested.git === false
        || !(requested.git || requested.access || requested.secrets?.length))) {
        throw new HubError("INVALID", { key: "runtime.invalid_job_result", args: [] });
      }
      store.db.transaction(() => {
        jobs.result(identity.actor.id, result.data);
        if (onResult) onResult(jobs.get(result.data.job));
      })();
      return Response.json(result.data);
    }
    if (!RuntimeHeartbeat.safeParse(body).success) throw new HubError("INVALID", { key: "runtime.invalid_runtime_heartbeat", args: [] });
    return store.db.transaction(() => {
      const heartbeat = RuntimeHeartbeat.parse(body), runtime = store.runtimes(now).find(value => value.actor === identity.actor.id);
      if (runtime) store.runtimeUpdates.report(runtime, heartbeat.update);
      const sync = jobs.sync(identity.actor.id, heartbeat, now);
      if (runtime) {
        const update = store.runtimeUpdates.directive(runtime);
        if (update) sync.update = update;
      }
      if (request.headers.get("X-Lumio-Features")?.split(",").some(value => value.trim() === "job-access")) {
        sync.access = sync.jobs.flatMap(spec => { const access = store.issueJobAccess(spec, now); return access ? [access] : []; });
      }
      return Response.json(RuntimeSync.parse(sync));
    })();
  } catch (cause) {
    execution = cause instanceof HubError ? cause.code : "INTERNAL";
    throw cause;
  } finally {
    // 心跳每隔几秒一次，查询列表也很频繁：成功放行的不记审计（与 P1-2"查询放行不必记"一致），
    // 否则审计表会被心跳淹没。拒绝、失败与登记照常记录。
    const routine = operation !== "runtime.register" && decision.result === "allow" && execution === "applied";
    if (!routine) store.audit(identity, operation, decision.result, undefined, execution);
  }
}
