import { WorkCommandRequest, WorkCommandResult, WorkCommandProposal } from "@lumio/schema";
import { WorkService } from "@lumio/work";
import { authorize } from "./authorize.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";

/** Shared HTTP/tool entry for Work writes. Approval never grants a human identity to the author. */
export class WorkCommands {
  constructor(private readonly store: HubStore, private readonly work: WorkService, private readonly decide: typeof authorize) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS work_proposal_requests(actor TEXT NOT NULL, request TEXT NOT NULL,
      operation TEXT NOT NULL, proposal TEXT NOT NULL REFERENCES proposals(id), PRIMARY KEY(actor,request))`);
  }
  execute(input: WorkCommandRequest, identity: Identity): WorkCommandResult {
    const request = WorkCommandRequest.parse(input), { operation } = request;
    const decision = this.decide(identity.actor, { operation: "work.command", command: operation.op, args: operation.args });
    if (decision.result === "deny") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: decision.reason });
    return this.store.db.transaction(() => {
      const previous = this.store.db.query<{ operation: string; proposal: string }, [string, string]>("SELECT operation,proposal FROM work_proposal_requests WHERE actor=? AND request=?").get(identity.actor.id, request.request_id);
      if (previous) {
        if (previous.operation !== JSON.stringify(operation)) throw new HubError("CONFLICT", { key: "index.request_id_was_used_for_a_different_operation", args: [] });
        return WorkCommandResult.parse({ kind: "proposal", proposal: previous.proposal });
      }
      const replay = this.work.replay(request, identity.actor.id);
      if (replay) return replay;
      if (decision.result === "needs_approval") {
        if (operation.op !== "work.task.dispatch" && operation.op !== "work.task.plan.set") throw new HubError("INVALID", { key: "capability.invalid", args: [] });
        const frozen = WorkCommandProposal.parse({ op: "work.command", args: this.work.proposalRequest(request) });
        const task = this.work.task(operation.args.task);
        const proposal = this.store.createProposal(frozen, `${operation.op}: ${task.title}`.slice(0, 2000), identity.actor.id);
        this.store.db.query("INSERT INTO work_proposal_requests(actor,request,operation,proposal) VALUES (?,?,?,?)").run(identity.actor.id, request.request_id, JSON.stringify(operation), proposal.id);
        this.store.audit(identity, operation.op, decision.result, proposal.id, "pending_approval");
        return WorkCommandResult.parse({ kind: "proposal", proposal: proposal.id });
      }
      const value = this.work.command(request, identity.actor.id);
      this.store.audit(identity, operation.op, "allow", undefined, "applied");
      return value;
    })();
  }
  /** Only the human proposal-decision route calls this, within the proposal-decision transaction. */
  approved(operation: WorkCommandProposal, author: Identity, proposal: string, approvedBy: string): WorkCommandResult {
    const value = this.work.command(operation.args, author.actor.id, { by: approvedBy, proposal });
    this.store.audit(author, JSON.stringify({ ...operation, approved_by: approvedBy }), "allow", proposal, "applied");
    return value;
  }
}
