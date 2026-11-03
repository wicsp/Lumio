import { randomBytes } from "node:crypto";
import { newId } from "@lumio/foundation";
import { ExecutionJobs, type RoutineHooks } from "@lumio/execution";
import { JobStatus } from "@lumio/schema";
import type { HubStore, Identity } from "./store.ts";
import type { authorize } from "./authorize.ts";
import { HubError } from "./errors.ts";

export { SubmitJob } from "@lumio/execution";
export type { RoutineHooks } from "@lumio/execution";

/** Compatibility factory for Hub adapters; lifecycle rules live in the Execution module. */
export class Jobs extends ExecutionJobs {
  constructor(store: HubStore, routines?: RoutineHooks) {
    super(store.executionStore, {
      id: (now) => newId("job", now, randomBytes), lease: () => randomBytes(32).toString("base64url"), now: () => new Date(),
    }, routines);
  }
}

export async function handleJobs(request: Request, operation: "job.submit" | "jobs" | "job.show" | "job.cancel",
  id: string | undefined, identity: Identity, store: HubStore, decide: typeof authorize, now: Date): Promise<Response> {
  const decision = decide(identity.actor, { operation });
  let execution = "applied";
  try {
    if (decision.result !== "allow") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: decision.result === "deny" ? decision.reason : "Approval required" });
    const jobs = new Jobs(store);
    if (operation === "job.submit") {
      let body: unknown; try { body = await request.json(); } catch { throw new HubError("INVALID", { key: "runtime.request_body_must_be_json", args: [] }); }
      return Response.json(jobs.submit(body, now));
    }
    if (operation === "jobs") {
      const params = new URL(request.url).searchParams;
      const status = params.get("status"), task = params.get("task"), routine = params.get("routine");
      if (status !== null && !JobStatus.safeParse(status).success) throw new HubError("INVALID", { key: "jobs.invalid_job_status", args: [] });
      if (task !== null && !/^task_[0-9A-HJKMNP-TV-Z]{26}$/.test(task)) throw new HubError("INVALID", { key: "jobs.task_must_be_a_task_id", args: [] });
      if (routine !== null && !/^rtn_[0-9A-HJKMNP-TV-Z]{26}$/.test(routine)) throw new HubError("INVALID", { key: "jobs.routine_must_be_a_routine_id", args: [] });
      return Response.json(jobs.list(status ?? undefined, task ?? undefined, routine ?? undefined));
    }
    return Response.json(operation === "job.cancel" ? jobs.cancel(id!) : jobs.get(id!));
  } catch (cause) { execution = cause instanceof HubError ? cause.code : "INTERNAL"; throw cause; }
  finally {
    if (operation === "job.submit" || operation === "job.cancel" || decision.result !== "allow" || execution !== "applied")
      store.audit(identity, operation, decision.result, undefined, execution);
  }
}
