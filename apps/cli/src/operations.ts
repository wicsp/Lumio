import { ApiClientError, createClient } from "@lumio/api-client";
import { OperationRequest, ProposalStatus, type Proposal } from "@lumio/schema";

export async function runOperations(args: string[], values: { reason?: string; status?: string; json?: boolean }, log: (line: string) => void): Promise<number> {
  const [command, action] = args;
  const link = (command === "link" && action === "add") || (command === "propose" && action === "link");
  const list = command === "proposals" && args.length === 1;
  const decision = command === "proposals" && (action === "accept" || action === "reject") && args.length === 3;
  if ((!link && !list && !decision) || (link && args.length !== 4) || (!link && values.reason !== undefined) || (!list && values.status !== undefined)) {
    throw new Error("用法：lumio link add|propose link <from> <to> [--reason 理由] [--json]；lumio proposals [--status pending|accepted|rejected] [--json]；lumio proposals accept|reject <ID> [--json]");
  }
  const url = process.env.LUMIO_HUB_URL, token = process.env.LUMIO_TOKEN;
  if (!url || !token) throw new Error("链接和提议必须经过 Hub 执行授权与安全写入，请设置 LUMIO_HUB_URL 和 LUMIO_TOKEN");
  const client = createClient({ url, token });
  async function render(proposals: Proposal[]) {
    const names = new Map((await client.actors()).map((actor) => [actor.id, actor.name]));
    for (const p of proposals) {
      const titles = await Promise.all([p.operation.args.from, p.operation.args.to].map(async (id) => {
        try { return (await client.show(id)).note.title; }
        catch (cause) { if (cause instanceof ApiClientError && cause.code === "NOT_FOUND") return id; throw cause; }
      }));
      log(`${p.id}  ${p.status}\n${titles[0]} → ${titles[1]}\n理由：${p.reason}\n提交者：${names.get(p.author) ?? p.author}  ${p.created}${p.decided_by ? `\n决定者：${names.get(p.decided_by) ?? p.decided_by}  ${p.decided}` : ""}`);
    }
  }
  if (link) {
    const notes = await Promise.all([args[2]!, args[3]!].map((ref) => client.show(ref)));
    if (notes.some((note) => !note.note.id)) throw new ApiClientError({ code: "INVALID", message: "链接只能引用有 ID 的笔记" });
    const request = OperationRequest.safeParse({ operation: { op: "link.add", args: { from: notes[0]!.note.id, to: notes[1]!.note.id } }, ...(values.reason !== undefined ? { reason: values.reason } : {}) });
    if (!request.success) throw new ApiClientError({ code: "INVALID", message: "操作或理由不合法" });
    const result = await client.operation(request.data);
    if (values.json) log(JSON.stringify(result));
    else if (result.status === "pending_approval") log(`已提交提议 ${result.proposal.id}，等待批准`);
    else log(`已添加链接：${notes[0]!.note.title} → ${notes[1]!.note.title}`);
  } else if (list) {
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
