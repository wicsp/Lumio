import { randomBytes } from "node:crypto";
import { newId } from "@lumio/foundation";
import { ExecutionJobs, type RoutineHooks } from "@lumio/execution";
import { SqliteExecutionStore } from "@lumio/storage";
import { JobStatus } from "@lumio/schema";
import type { HubStore, Identity } from "./store.ts";
import type { authorize } from "./authorize.ts";
import { HubError } from "./errors.ts";

export { SubmitJob } from "@lumio/execution";
export type { RoutineHooks } from "@lumio/execution";

/** Compatibility factory for Hub adapters; lifecycle rules live in the Execution module. */
export class Jobs extends ExecutionJobs {
  constructor(store: HubStore, routines?: RoutineHooks) {
    super(new SqliteExecutionStore(store.db, store), {
      id: (now) => newId("job", now, randomBytes), lease: () => randomBytes(32).toString("base64url"), now: () => new Date(),
    }, routines);
  }
}

export async function handleJobs(request: Request, operation: "job.submit" | "jobs" | "job.show" | "job.cancel",
  id: string | undefined, identity: Identity, store: HubStore, decide: typeof authorize, now: Date): Promise<Response> {
  const decision = decide(identity.actor, { operation });
  let execution = "applied";
  try {
    if (decision.result !== "allow") throw new HubError("FORBIDDEN", "请求未获授权", { reason: decision.result === "deny" ? decision.reason : "Approval required" });
    const jobs = new Jobs(store);
    if (operation === "job.submit") {
      let body: unknown; try { body = await request.json(); } catch { throw new HubError("INVALID", "请求体必须是 JSON"); }
      return Response.json(jobs.submit(body, now));
    }
    if (operation === "jobs") {
      const params = new URL(request.url).searchParams;
      const status = params.get("status"), task = params.get("task"), routine = params.get("routine");
      if (status !== null && !JobStatus.safeParse(status).success) throw new HubError("INVALID", "Job 状态不合法");
      if (task !== null && !/^task_[0-9A-HJKMNP-TV-Z]{26}$/.test(task)) throw new HubError("INVALID", "task 必须是任务 ID");
      if (routine !== null && !/^rtn_[0-9A-HJKMNP-TV-Z]{26}$/.test(routine)) throw new HubError("INVALID", "routine 必须是例行任务 ID");
      return Response.json(jobs.list(status ?? undefined, task ?? undefined, routine ?? undefined));
    }
    return Response.json(operation === "job.cancel" ? jobs.cancel(id!) : jobs.get(id!));
  } catch (cause) { execution = cause instanceof HubError ? cause.code : "INTERNAL"; throw cause; }
  finally {
    if (operation === "job.submit" || operation === "job.cancel" || decision.result !== "allow" || execution !== "applied")
      store.audit(identity, operation, decision.result, undefined, execution);
  }
}
