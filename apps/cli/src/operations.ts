import { language } from "@lumio/platform";
import { text as msg } from "./messages.ts";
import { hubCredentials } from "./config.ts";
import { createClient } from "@lumio/api-client";
import { ProposalStatus, type Proposal } from "@lumio/schema";

/** 提议：列出、接受、拒绝（ADR 0016）。link add / propose link 已删除（ADR 0018）。 */
export async function runOperations(args: string[], values: { reason?: string; status?: string; json?: boolean }, log: (line: string) => void): Promise<number> {
  const [command, action] = args;
  const list = command === "proposals" && args.length === 1;
  const decision = command === "proposals" && (action === "accept" || action === "reject") && args.length === 3;
  if ((!list && !decision) || values.reason !== undefined || (!list && values.status !== undefined)) {
    throw new Error(msg("operations.usage_lumio_proposals_status_pending_accepted_rejected_json_lumio_pr"));
  }
  const { url, token } = hubCredentials();
  const client = createClient({ language: language(), url, token });
  async function render(proposals: Proposal[]) {
    const names = new Map((await client.actors()).map((actor) => [actor.id, actor.name]));
    for (const p of proposals) {
      let command = `${p.operation.op} ${JSON.stringify(p.operation.args)}`;
      if (p.operation.op === "exec.privileged") {
        const { runtime, job: id, argv } = p.operation.args;
        command = msg("operations.run_as_root_on", names.get(runtime) ?? runtime, argv.map((a) => /^[a-zA-Z0-9_./:=+,-]+$/.test(a) ? a : JSON.stringify(a)).join(" "));
        try {
          const job = await client.job(id);
          const source = job.spec.source;
          if (source?.task || source?.routine) {
            const ref = source.task ?? source.routine!;
            let title = ref;
            try { title = (await client.show(ref)).note.title; } catch { /* 来源笔记可能已删除。 */ }
            command += msg("operations.source", title, source.task ? msg("operations.round", source.round) : msg("operations.routine"));
          } else command += msg("operations.source_2", id);
        } catch { command += msg("operations.source_2", id); }
      }
      log(msg("operations.reason_submitted_by", p.id, p.status, command, p.reason, names.get(p.author) ?? p.author, p.created, p.decided_by ? msg("operations.decided_by", names.get(p.decided_by) ?? p.decided_by, p.decided) : ""));
    }
  }
  if (list) {
    const status = ProposalStatus.safeParse(values.status ?? "pending");
    if (!status.success) throw new Error(msg("operations.proposal_status_must_be_pending_accepted_or_rejected"));
    const proposals = await client.proposals(status.data);
    if (values.json) log(JSON.stringify(proposals));
    else if (!proposals.length) log(msg("operations.no_proposals"));
    else await render(proposals);
  } else {
    const proposal = await (action === "accept" ? client.acceptProposal : client.rejectProposal)(args[2]!);
    if (values.json) log(JSON.stringify(proposal));
    else await render([proposal]);
  }
  return 0;
}
