import { WorkError } from "@lumio/work";
import type { WorkCommands } from "./work-commands.ts";
import { text as msg } from "./messages.ts";
import type { Privileged } from "./privileged.ts";
import { CoreError } from "@lumio/foundation";
import { Actor, OperationRequest, OperationResult, Proposal, type ProposalOperation, ProposalStatus } from "@lumio/schema";
import { authorize } from "./authorize.ts";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";
export interface OperationOptions { workCommands?: WorkCommands; privileged?: Privileged }

export async function handleOperation(request: Request, kind: "operations" | "actors" | "proposals" | "proposal.accept" | "proposal.reject", proposalId: string | undefined,
  identity: Identity, store: HubStore, _config: HubConfig, decide: typeof authorize, options: OperationOptions = {}): Promise<Response> {
  let operation: ProposalOperation | undefined;
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
    if (decision.result === "deny") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { operation: operation?.op === "work.command" ? undefined : operation, reason: decision.reason, proposal: proposal?.id });
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
      if (decision.result !== "needs_approval") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { operation });
      if (!parsed.data.reason) throw new HubError("INVALID", { key: "operations.a_proposal_reason_is_required", args: [] }, { operation });
      if (!options.privileged) throw new HubError("INTERNAL", { key: "operations.privileged_approval_is_not_enabled", args: [] });
      options.privileged.validate(operation, identity.actor.id);
      proposal = store.createProposal(operation, parsed.data.reason, identity.actor.id);
      audit("pending_approval");
      return Response.json(OperationResult.parse({ status: "pending_approval", proposal }), { status: 202 });
    }
    proposal = store.proposal(proposalId!);
    operation = proposal?.operation;
    // Authorize before exposing existence or status to an agent.
    if (check(kind).result !== "allow") throw new HubError("FORBIDDEN", { key: "operations.request_requires_approval", args: [] }, { operation: operation?.op === "work.command" ? undefined : operation });
    if (!proposal) throw new HubError("NOT_FOUND", { key: "operations.proposal_not_found", args: [] });
    if (proposal.status !== "pending") throw new HubError("CONFLICT", { key: "operations.only_pending_proposals_can_be_decided", args: [] }, { operation: operation?.op === "work.command" ? undefined : operation, proposal: proposal.id });
    if (operation?.op === "work.command") {
      const workOperation = operation;
      proposal = store.db.transaction(() => {
        if (kind === "proposal.accept") {
          const author = store.actors().find(actor => actor.id === proposal!.author);
          if (!author || !options.workCommands) throw new HubError("CONFLICT", { key: "operations.the_proposal_s_author_no_longer_exists", args: [] });
          options.workCommands.approved(workOperation, { actor: author, label: "approved-work-proposal" }, proposal!.id, identity.actor.id);
        }
        const decided = store.decideProposal(proposal!.id, kind === "proposal.accept" ? "accepted" : "rejected", identity.actor.id);
        store.audit(identity, kind, "allow", decided.id, decided.status); audited = true; return decided;
      })();
      return Response.json(Proposal.parse(proposal));
    }
    if (kind === "proposal.accept") {
      // 以提议作者的身份执行：批准者只是放行（审计里同时记录批准者）。
      const author = store.actors().find((a) => a.id === proposal!.author);
      if (!author) throw new HubError("CONFLICT", { key: "operations.the_proposal_s_author_no_longer_exists", args: [] }, { operation, proposal: proposal.id });
      if (!options.privileged) throw new HubError("INTERNAL", { key: "operations.privileged_approval_is_not_enabled", args: [] });
      options.privileged.approve(proposal, identity);
    }
    proposal = store.decideProposal(proposal.id, kind === "proposal.accept" ? "accepted" : "rejected", identity.actor.id);
    audit(proposal.status);
    return Response.json(Proposal.parse(proposal));
  } catch (caught) {
    const cause = caught instanceof WorkError ? new HubError(caught.code, caught.params, { reason: caught.reason }) : caught;
    if ((kind === "actors" || kind === "proposals") && authorization === "deny") store.audit(identity, kind, "deny");
    if (kind !== "actors" && kind !== "proposals" && !audited) audit(cause instanceof CoreError || cause instanceof HubError ? cause.code : "INTERNAL");
    if (cause instanceof CoreError && ["FILE_CHANGED", "WRITE_FAILED", "GIT_FAILED"].includes(cause.code)) {
      throw new HubError("CONFLICT", { key: "operations.file_changed_or_could_not_be_written_safely_retry", args: [proposal ? msg("operations.proposal_remains_pending") : ""] }, { operation: operation?.op === "work.command" ? undefined : operation, proposal: proposal?.id });
    }
    if (cause instanceof HubError) throw new HubError(cause.code, cause.params, { operation: operation?.op === "work.command" ? undefined : operation, proposal: proposal?.id, ...cause.details });
    throw cause;
  }
}
