import { executionTargets } from "./targets.ts";
import { text as msg } from "./messages.ts";
import { WorkCommandRequest, WorkCommandResult, WorkCommandProposal, DispatchTargetSource, parseAssignee } from "@lumio/schema";
import { WorkService } from "@lumio/work";
import { authorize } from "./authorize.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";

/** Shared HTTP/tool entry for Work writes. Approval never grants a human identity to the author. */
export class WorkCommands {
  constructor(private readonly store: HubStore, private readonly work: WorkService, private readonly decide: typeof authorize, private readonly localRuntime?: string, private readonly now = () => new Date()) {
    store.db.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS work_proposal_requests(actor TEXT NOT NULL, request TEXT NOT NULL,
        operation TEXT NOT NULL, proposal TEXT NOT NULL REFERENCES proposals(id), target_source TEXT, PRIMARY KEY(actor,request))`);
      const columns = store.db.query<{ name: string }, []>("PRAGMA table_info(work_proposal_requests)").all();
      if (!columns.some(column => column.name === "target_source")) store.db.exec("ALTER TABLE work_proposal_requests ADD COLUMN target_source TEXT");
    }).immediate();
  }
  offlineTargets(operation: WorkCommandRequest["operation"], result?: WorkCommandResult): string[] {
    if (result?.kind === "proposal") {
      const frozen = this.store.proposal(result.proposal)?.operation;
      return frozen?.op === "work.command" ? this.offlineTargets(frozen.args.operation) : [];
    }
    let targets: string[] = [];
    switch (operation.op) {
      case "work.task.plan.set":
        targets = operation.args.plan?.stages.flatMap(stage => stage.kind === "agent" ? [stage.agent] : []) ?? [];
        break;
      case "work.task.dispatch": {
        const target = result?.kind === "job" ? result.target ?? operation.args.to : result === undefined ? operation.args.to : undefined;
        if (target) targets = [target];
        break;
      }
      case "work.project.create":
      case "work.project.update": {
        const target = result?.kind === "project" ? result.project.default_target : undefined;
        if (target) targets = [target];
        break;
      }
    }
    if (!targets.length) return [];
    return executionTargets(this.store, this.now()).filter(value => !value.online && targets.some(target => {
      const parsed = parseAssignee(target);
      return parsed !== "human" && value.runtime === (parsed.device ?? this.localRuntime) && value.engine === parsed.agent;
    })).map(value => value.target);
  }
  execute(input: WorkCommandRequest, identity: Identity): WorkCommandResult {
    const request = WorkCommandRequest.parse(input), { operation } = request;
    if ((operation.op === "work.task.delete" || operation.op === "work.project.delete") && identity.actor.role !== "human") {
      throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: "agent-cannot-delete-or-archive" });
    }
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
        const { request: frozenRequest, source } = this.work.proposalRequest(request);
        const frozen = WorkCommandProposal.parse({ op: "work.command", args: frozenRequest });
        const task = this.work.task(operation.args.task);
        const offline = this.offlineTargets(frozen.args.operation);
        const reason = [`${operation.op}: ${task.title}`, ...(offline.length ? [msg("target.offline", offline.join(", "))] : [])].join("\n").slice(0, 2000);
        const proposal = this.store.createProposal(frozen, reason, identity.actor.id);
        for (const previous of this.store.proposals("pending", identity.actor.id)) {
          if (previous.id === proposal.id || previous.operation.op !== "work.command") continue;
          const old = previous.operation.args.operation;
          if (old.op === operation.op && old.args.task === operation.args.task) this.store.withdrawProposal(previous.id, identity, proposal.id);
        }
        this.store.db.query("INSERT INTO work_proposal_requests(actor,request,operation,proposal,target_source) VALUES (?,?,?,?,?)").run(identity.actor.id, request.request_id, JSON.stringify(operation), proposal.id, source ?? null);
        this.store.audit(identity, operation.op, decision.result, proposal.id, "pending_approval");
        return WorkCommandResult.parse({ kind: "proposal", proposal: proposal.id });
      }
      const value = this.work.command(request, identity.actor.id, undefined, { role: identity.actor.role, job: identity.job });
      this.store.audit(identity, operation.op, "allow", undefined, "applied");
      return value;
    })();
  }
  /** Only the human proposal-decision route calls this, within the proposal-decision transaction. */
  approved(operation: WorkCommandProposal, author: Identity, proposal: string, approvedBy: string): WorkCommandResult {
    const saved = this.store.db.query<{ target_source: string | null }, [string, string, string]>(
      "SELECT target_source FROM work_proposal_requests WHERE actor=? AND request=? AND proposal=?"
    ).get(author.actor.id, operation.args.request_id, proposal);
    const targetSource = DispatchTargetSource.nullish().parse(saved?.target_source) ?? undefined;
    const value = this.work.command(operation.args, author.actor.id, { by: approvedBy, proposal, targetSource }, { role: author.actor.role });
    this.store.audit(author, JSON.stringify({ ...operation, approved_by: approvedBy }), "allow", proposal, "applied");
    return value;
  }
}
