import { createClient } from "@lumio/api-client";
import { ProposalStatus, type Proposal } from "@lumio/schema";

/** 提议：列出、接受、拒绝（ADR 0016）。link add / propose link 已删除（ADR 0018）。 */
export async function runOperations(args: string[], values: { reason?: string; status?: string; json?: boolean }, log: (line: string) => void): Promise<number> {
  const [command, action] = args;
  const list = command === "proposals" && args.length === 1;
  const decision = command === "proposals" && (action === "accept" || action === "reject") && args.length === 3;
  if ((!list && !decision) || values.reason !== undefined || (!list && values.status !== undefined)) {
    throw new Error("用法：lumio proposals [--status pending|accepted|rejected] [--json]；lumio proposals accept|reject <ID> [--json]");
  }
  const url = process.env.LUMIO_HUB_URL, token = process.env.LUMIO_TOKEN;
  if (!url || !token) throw new Error("提议必须经过 Hub 执行授权与安全写入，请设置 LUMIO_HUB_URL 和 LUMIO_TOKEN");
  const client = createClient({ url, token });
  async function render(proposals: Proposal[]) {
    const names = new Map((await client.actors()).map((actor) => [actor.id, actor.name]));
    for (const p of proposals) {
      log(`${p.id}  ${p.status}\n${p.operation.op} ${JSON.stringify(p.operation.args)}\n理由：${p.reason}\n提交者：${names.get(p.author) ?? p.author}  ${p.created}${p.decided_by ? `\n决定者：${names.get(p.decided_by) ?? p.decided_by}  ${p.decided}` : ""}`);
    }
  }
  if (list) {
    const status = ProposalStatus.safeParse(values.status ?? "pending");
    if (!status.success) throw new Error("提议状态必须是 pending、accepted 或 rejected");
    const proposals = await client.proposals(status.data);
    if (values.json) log(JSON.stringify(proposals));
    else if (!proposals.length) log("没有提议");
    else await render(proposals);
  } else {
    const proposal = await (action === "accept" ? client.acceptProposal : client.rejectProposal)(args[2]!);
    if (values.json) log(JSON.stringify(proposal));
    else await render([proposal]);
  }
  return 0;
}
