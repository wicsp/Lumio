import { RuntimeHeartbeat, RuntimeInfo, RuntimeRegistration, RuntimeSync } from "@lumio/schema";
import type { authorize } from "./authorize.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";

export async function handleRuntime(request: Request, operation: "runtime.register" | "runtime.sync" | "runtimes",
  identity: Identity, store: HubStore, decide: typeof authorize, now: Date): Promise<Response> {
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
    if (!RuntimeHeartbeat.safeParse(body).success) throw new HubError("INVALID", "执行器心跳不合法");
    store.syncRuntime(identity.actor.id, now);
    return Response.json(RuntimeSync.parse({ jobs: [], cancel: [], routines: [] }));
  } catch (cause) {
    execution = cause instanceof HubError ? cause.code : "INTERNAL";
    throw cause;
  } finally { store.audit(identity, operation, decision.result, undefined, execution); }
}
