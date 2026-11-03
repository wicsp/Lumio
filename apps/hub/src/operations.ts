import { text as msg } from "./messages.ts";
import type { Privileged } from "./privileged.ts";
import { CoreError } from "@lumio/foundation";
import { Actor, OperationRequest, OperationResult, Proposal, ProposalStatus, type NoteRef, type Operation } from "@lumio/schema";
import { authorize } from "./authorize.ts";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";
import type { TaskRounds } from "./tasks.ts";
import type { Routines } from "./routines.ts";

/**
 * 统一的操作入口（ADR 0016）：先授权（允许 / 拒绝 / 需要批准），再执行；需要批准的原样存成提议，人接受后执行同一个操作。
 * 现在的操作：task.dispatch（P2-4）、routine.followup（P2-5）。exec.privileged 由 P2-6 加入。link.add 已删除（ADR 0018）。
 */
export interface OperationOptions { tasks?: TaskRounds; routines?: Routines; privileged?: Privileged; isManagedTask?: (id: string) => boolean; isManagedRoutine?: (id: string) => boolean }

/** 执行一个已经获准的操作。直接执行与接受提议共用这一个函数。 */
async function execute(operation: Operation, identity: Identity, options: OperationOptions): Promise<NoteRef | undefined> {
  if (operation.op === "task.dispatch") {
    if (options.isManagedTask?.(operation.args.task)) throw new HubError("CONFLICT", { key: "operations.this_task_is_managed_by_the_database_use_work_task_dispatch", args: [] });
    if (!options.tasks) throw new HubError("INTERNAL", { key: "operations.task_dispatch_is_not_enabled_on_hub", args: [] });
    await options.tasks.dispatch(operation.args.task, operation.args.trigger, identity, undefined, operation.args.to);
    return;
  }
  if (operation.op === "routine.followup") {
    if (options.isManagedRoutine?.(operation.args.routine)) throw new HubError("CONFLICT", { key: "operations.this_routine_is_managed_by_the_database_use_the_new_routine_followup", args: [] });
    if (!options.routines) throw new HubError("INTERNAL", { key: "operations.routines_are_not_enabled_on_hub", args: [] });
    return options.routines.followup(operation.args.routine, operation.args.job, identity);
  }
  throw new HubError("INVALID", { key: "operations.unsupported_operation", args: [] }, { operation });
}

export async function handleOperation(request: Request, kind: "operations" | "actors" | "proposals" | "proposal.accept" | "proposal.reject", proposalId: string | undefined,
  identity: Identity, store: HubStore, _config: HubConfig, decide: typeof authorize, options: OperationOptions = {}): Promise<Response> {
  let operation: Operation | undefined;
  let proposal: Proposal | undefined;
  let authorization = "deny";
  let audited = false;
  const audit = (execution: string) => {
    store.audit(identity, operation ? JSON.stringify(operation) : kind, authorization, proposal?.id, execution);
    audited = true;
  };
  const check = (name: Parameters<typeof authorize>[1]["operation"]) => {
    const decision = decide(identity.actor, { operation: name });
    authorization = decision.result;
    if (decision.result === "deny") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { operation, reason: decision.reason, proposal: proposal?.id });
    return decision;
  };
  try {
    if (kind === "actors") {
      if (check("actors").result !== "allow") throw new HubError("FORBIDDEN", { key: "operations.request_requires_approval", args: [] });
      return Response.json(Actor.array().parse(store.actors()));
    }
    if (kind === "proposals") {
      if (check("proposals").result !== "allow") throw new HubError("FORBIDDEN", { key: "operations.request_requires_approval", args: [] });
      const status = ProposalStatus.safeParse(new URL(request.url).searchParams.get("status") ?? "pending");
      if (!status.success) throw new HubError("INVALID", { key: "operations.invalid_proposal_status", args: [] });
      return Response.json(Proposal.array().parse(store.proposals(status.data, identity.actor.role === "agent" ? identity.actor.id : undefined)));
    }
    if (kind === "operations") {
      let body: unknown;
      try { body = await request.json(); } catch { throw new HubError("INVALID", { key: "runtime.request_body_must_be_json", args: [] }); }
      const parsed = OperationRequest.safeParse(body);
      if (!parsed.success) throw new HubError("INVALID", { key: "operations.invalid_operation_request", args: [] });
      operation = parsed.data.operation;
      const decision = check(operation.op);
      if (decision.result === "needs_approval") {
        if (!parsed.data.reason) throw new HubError("INVALID", { key: "operations.a_proposal_reason_is_required", args: [] }, { operation });
        if (operation.op === "exec.privileged") {
          if (!options.privileged) throw new HubError("INTERNAL", { key: "operations.privileged_approval_is_not_enabled", args: [] });
          options.privileged.validate(operation, identity.actor.id);
        }
        proposal = store.createProposal(operation, parsed.data.reason, identity.actor.id);
        audit("pending_approval");
        return Response.json(OperationResult.parse({ status: "pending_approval", proposal }), { status: 202 });
      }
      const note = await execute(operation, identity, options);
      audit("applied");
      return Response.json(OperationResult.parse({ status: "applied", operation, ...(note ? { note } : {}) }));
    }
    proposal = store.proposal(proposalId!);
    operation = proposal?.operation;
    // Authorize before exposing existence or status to an agent.
    if (check(kind).result !== "allow") throw new HubError("FORBIDDEN", { key: "operations.request_requires_approval", args: [] }, { operation });
    if (!proposal) throw new HubError("NOT_FOUND", { key: "operations.proposal_not_found", args: [] });
    if (proposal.status !== "pending") throw new HubError("CONFLICT", { key: "operations.only_pending_proposals_can_be_decided", args: [] }, { operation, proposal: proposal.id });
    if (kind === "proposal.accept") {
      // 以提议作者的身份执行：批准者只是放行（审计里同时记录批准者）。
      const author = store.actors().find((a) => a.id === proposal!.author);
      if (!author) throw new HubError("CONFLICT", { key: "operations.the_proposal_s_author_no_longer_exists", args: [] }, { operation, proposal: proposal.id });
      if (operation!.op === "exec.privileged") {
        if (!options.privileged) throw new HubError("INTERNAL", { key: "operations.privileged_approval_is_not_enabled", args: [] });
        options.privileged.approve(proposal, identity);
      } else await execute(operation!, { actor: author, label: identity.label }, options);
    }
    proposal = store.decideProposal(proposal.id, kind === "proposal.accept" ? "accepted" : "rejected", identity.actor.id);
    audit(proposal.status);
    return Response.json(Proposal.parse(proposal));
  } catch (cause) {
    if ((kind === "actors" || kind === "proposals") && authorization === "deny") store.audit(identity, kind, "deny");
    if (kind !== "actors" && kind !== "proposals" && !audited) audit(cause instanceof CoreError || cause instanceof HubError ? cause.code : "INTERNAL");
    if (cause instanceof CoreError && ["FILE_CHANGED", "WRITE_FAILED", "GIT_FAILED"].includes(cause.code)) {
      throw new HubError("CONFLICT", { key: "operations.file_changed_or_could_not_be_written_safely_retry", args: [proposal ? msg("operations.proposal_remains_pending") : ""] }, { operation, proposal: proposal?.id });
    }
    if (cause instanceof HubError) throw new HubError(cause.code, cause.params, { operation, proposal: proposal?.id, ...cause.details });
    throw cause;
  }
}
