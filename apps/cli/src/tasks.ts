import { hubCredentials } from "./config.ts";
import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { Job, TaskDispatch, parseAssignee } from "@lumio/schema";

const usage = "用法：lumio task continue <任务> [--to pi@server] [--json]；lumio task show <任务> [--json]；lumio task list";
const OUTCOME: Record<string, string> = { queued: "排队中", assigned: "已派出", running: "执行中", done: "完成", waiting_for_human: "等你回答",
  failed: "失败", unknown: "情况不明", cancelled: "已取消" };

/** 任务的一问一答（ADR 0019，P2-4）：派出下一轮、查看各轮。只能经 Hub。 */
export async function runTasks(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: "boolean" }, to: { type: "string" } } });
  const [action, reference] = positionals;
  if (action === "list" ? positionals.length !== 1 || values.to !== undefined || values.json : positionals.length !== 2 || !reference || (action !== "continue" && action !== "show")) throw new Error(usage);
  if (values.to !== undefined && (action !== "continue" || parseAssignee(values.to) === "human")) throw new Error("--to 必须指定 agent，例如 pi@server");
  const { url, token } = hubCredentials();
  const client = createClient({ url, token });
  if (action === "list") {
    let result = await client.search("", { type: "task" });
    if (result.hits.length < result.total) result = await client.search("", { type: "task", limit: result.total });
    const jobs = await client.jobs();
    for (const { note } of result.hits) {
      const detail = await client.show(note.id ?? note.path.replace(/^.*\//, "").replace(/\.md$/, ""));
      const assignee = parseAssignee(detail.frontmatter.assignee ?? "human");
      const name = assignee === "human" ? "human" : `${assignee.agent}${assignee.device ? `@${assignee.device}` : ""}`;
      const active = jobs.some((j) => j.spec.source?.task === note.id && ["queued", "assigned", "running"].includes(j.status));
      log(`${note.title}  ${name}  ${active ? "执行中" : assignee !== "human" ? "等待派出" : "无"}  ${note.path}`);
    }
    return 0;
  }
  const note = await client.show(reference!);
  if (note.note.type !== "task" || !note.note.id) throw new Error("这不是一篇有 ID 的任务笔记");
  const task = note.note.id;
  if (action === "continue") {
    const operation = TaskDispatch.parse({ op: "task.dispatch", args: { task, trigger: "cli", ...(values.to !== undefined ? { to: values.to } : {}) } });
    await client.operation({ operation });
  }
  const rounds = Job.array().parse(await client.jobs(undefined, task));
  if (values.json) { log(JSON.stringify(action === "continue" ? rounds.at(-1) : rounds)); return 0; }
  if (action === "continue") log(`已派出第 ${rounds.at(-1)?.spec.source?.round ?? "?"} 轮：${rounds.at(-1)?.spec.id ?? ""}`);
  else {
    log(`${note.note.title}  ${note.note.path}`);
    if (!rounds.length) log("还没有派出过");
    const names = new Map((await client.runtimes()).map((r) => [r.actor, r.registration.name]));
    for (const job of rounds) {
      const engine = job.spec.run.kind === "agent" ? job.spec.run.engine : "command";
      log(`第 ${job.spec.source?.round ?? "?"} 轮  ${OUTCOME[job.status] ?? job.status}  ${engine}@${names.get(job.spec.runtime) ?? job.spec.runtime}  ${job.spec.created.slice(0, 16).replace("T", " ")}  ${job.spec.id}`);
    }
  }
  return 0;
}
