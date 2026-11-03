import { language } from "@lumio/platform";
import { text as msg } from "./messages.ts";
import { hubCredentials } from "./config.ts";
import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { Job, TaskDispatch, parseAssignee } from "@lumio/schema";

const usage = () => msg("tasks.usage_lumio_task_continue_task_to_pi_server_json_lumio_task_show_tas");
const outcomes = (): Record<string, string> => ({ queued: msg("tasks.queued"), assigned: msg("tasks.dispatched"), running: msg("tasks.running"), done: msg("tasks.completed"), waiting_for_human: msg("tasks.waiting_for_you"),
  failed: msg("tasks.failed"), unknown: msg("tasks.unknown"), cancelled: msg("tasks.cancelled") });

/** 任务的一问一答（ADR 0019，P2-4）：派出下一轮、查看各轮。只能经 Hub。 */
export async function runTasks(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: "boolean" }, to: { type: "string" } } });
  const [action, reference] = positionals;
  if (action === "list" ? positionals.length !== 1 || values.to !== undefined || values.json : positionals.length !== 2 || !reference || (action !== "continue" && action !== "show")) throw new Error(usage());
  if (values.to !== undefined && (action !== "continue" || parseAssignee(values.to) === "human")) throw new Error(msg("tasks.to_must_specify_an_agent_e_g_pi_server"));
  const { url, token } = hubCredentials();
  const client = createClient({ language: language(), url, token });
  if (action === "list") {
    let result = await client.search("", { type: "task" });
    if (result.hits.length < result.total) result = await client.search("", { type: "task", limit: result.total });
    const jobs = await client.jobs();
    for (const { note } of result.hits) {
      const detail = await client.show(note.id ?? note.path.replace(/^.*\//, "").replace(/\.md$/, ""));
      const assignee = parseAssignee(detail.frontmatter.assignee ?? "human");
      const name = assignee === "human" ? "human" : `${assignee.agent}${assignee.device ? `@${assignee.device}` : ""}`;
      const active = jobs.some((j) => j.spec.source?.task === note.id && ["queued", "assigned", "running"].includes(j.status));
      log(`${note.title}  ${name}  ${active ? msg("tasks.running") : assignee !== "human" ? msg("tasks.waiting_for_dispatch") : msg("tasks.none")}  ${note.path}`);
    }
    return 0;
  }
  const note = await client.show(reference!);
  if (note.note.type !== "task" || !note.note.id) throw new Error(msg("tasks.this_is_not_a_task_note_with_an_id"));
  const task = note.note.id;
  if (action === "continue") {
    const operation = TaskDispatch.parse({ op: "task.dispatch", args: { task, trigger: "cli", ...(values.to !== undefined ? { to: values.to } : {}) } });
    await client.operation({ operation });
  }
  const rounds = Job.array().parse(await client.jobs(undefined, task));
  if (values.json) { log(JSON.stringify(action === "continue" ? rounds.at(-1) : rounds)); return 0; }
  if (action === "continue") log(msg("tasks.dispatched_round", rounds.at(-1)?.spec.source?.round ?? "?", rounds.at(-1)?.spec.id ?? ""));
  else {
    log(`${note.note.title}  ${note.note.path}`);
    if (!rounds.length) log(msg("tasks.never_dispatched"));
    const names = new Map((await client.runtimes()).map((r) => [r.actor, r.registration.name]));
    for (const job of rounds) {
      const engine = job.spec.run.kind === "agent" ? job.spec.run.engine : "command";
      log(msg("tasks.round", job.spec.source?.round ?? "?", outcomes()[job.status] ?? job.status, engine, names.get(job.spec.runtime) ?? job.spec.runtime, job.spec.created.slice(0, 16).replace("T", " "), job.spec.id));
    }
  }
  return 0;
}
