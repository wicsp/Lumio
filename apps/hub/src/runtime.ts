import { JobResult, RuntimeAck, RuntimeHeartbeat, RuntimeInfo, RuntimeRegistration, RuntimeSync } from "@lumio/schema";
import { Jobs, type RoutineHooks } from "./jobs.ts";
import type { authorize } from "./authorize.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";

export async function handleRuntime(request: Request, operation: "runtime.register" | "runtime.sync" | "runtime.ack" | "runtime.results" | "runtimes",
  identity: Identity, store: HubStore, decide: typeof authorize, now: Date, routines?: RoutineHooks): Promise<Response> {
  const decision = decide(identity.actor, { operation });
  let execution = "applied";
  try {
    if (decision.result !== "allow") throw new HubError("FORBIDDEN", "请求未获授权", {
      reason: decision.result === "deny" ? decision.reason : "Approval required",
    });
    if (operation === "runtimes") return Response.json(RuntimeInfo.array().parse(store.runtimes(now)));
    let body: unknown;
    try { body = await request.json(); } catch { throw new HubError("INVALID", "请求体必须是 JSON"); }
    if (operation === "runtime.register") {
      const registration = RuntimeRegistration.safeParse(body);
      if (!registration.success) throw new HubError("INVALID", "执行器登记内容不合法");
      return Response.json(store.registerRuntime(identity.actor.id, registration.data, now));
    }
    const jobs = new Jobs(store, routines);
    if (operation === "runtime.ack") {
      const ack = RuntimeAck.safeParse(body);
      if (!ack.success) throw new HubError("INVALID", "Job 确认内容不合法");
      jobs.ack(identity.actor.id, ack.data.accepted, now);
      return Response.json(ack.data);
    }
    if (operation === "runtime.results") {
      const result = JobResult.safeParse(body);
      if (!result.success) throw new HubError("INVALID", "Job 结果不合法");
      jobs.result(identity.actor.id, result.data);
      return Response.json(result.data);
    }
    if (!RuntimeHeartbeat.safeParse(body).success) throw new HubError("INVALID", "执行器心跳不合法");
    return Response.json(RuntimeSync.parse(jobs.sync(identity.actor.id, RuntimeHeartbeat.parse(body), now)));
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
