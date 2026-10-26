import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { AgentRun, JobStatus, type Job } from "@lumio/schema";

const usage = "用法：lumio job submit --runtime <名称> [--workdir 路径] [--timeout 30m] [--gpus 0,1] -- <程序> [参数…]；" +
  "lumio job submit --runtime <名称> --agent codex|claude-code|pi [--model 模型] [--session ID [--resume]] [--workdir 路径] [--timeout 2h] [--gpus 0,1] \"<要求>\"；lumio job list [--status 状态] [--json]；lumio job show <job> [--json]；lumio job cancel <job>";
export async function runJobs(args: string[], log: (line: string) => void) {
  const split = args.indexOf("--");
  const { values, positionals } = parseArgs({ args: split < 0 ? args : args.slice(0, split), allowPositionals: true, strict: true, options: {
    runtime: { type: "string" }, workdir: { type: "string" }, timeout: { type: "string" }, gpus: { type: "string" }, status: { type: "string" }, json: { type: "boolean" },
    agent: { type: "string" }, model: { type: "string" }, session: { type: "string" }, resume: { type: "boolean" },
  } });
  const [action, id] = positionals;
  const keys = Object.keys(values);
  const agentKeys = ["agent", "model", "session", "resume"];
  if (action === "submit" && values.agent !== undefined) {
    // agent 类型：要求是唯一的位置参数，不用 --。
    if (positionals.length !== 2 || split >= 0 || !positionals[1] || !values.runtime || (values.resume && !values.session)
      || keys.some((k) => !["runtime", "workdir", "timeout", "gpus", "json", ...agentKeys].includes(k))) throw new Error(usage);
  } else if (action === "submit") {
    if (positionals.length !== 1 || split < 0 || !args[split + 1] || !values.runtime || keys.some((k) => !["runtime", "workdir", "timeout", "gpus", "json"].includes(k))) throw new Error(usage);
  } else if (action === "list") {
    if (positionals.length !== 1 || split >= 0 || keys.some((k) => !["status", "json"].includes(k))) throw new Error(usage);
  } else if (action === "show" || action === "cancel") {
    if (positionals.length !== 2 || split >= 0 || keys.some((k) => k !== "json")) throw new Error(usage);
  } else throw new Error(usage);
  const url = process.env.LUMIO_HUB_URL, token = process.env.LUMIO_TOKEN;
  if (!url || !token) throw new Error("job 命令需要设置非空的 LUMIO_HUB_URL 和 LUMIO_TOKEN");
  const client = createClient({ url, token });
  let result: Job | Job[];
  if (action === "submit") {
    let timeout: number | undefined, gpus: number[] | undefined;
    if (values.timeout !== undefined) {
      const match = /^([1-9]\d*)(s|m|h)$/.exec(values.timeout);
      if (!match) throw new Error("timeout 格式为正整数加 s、m 或 h，例如 30m");
      timeout = Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2]!]!);
      if (!Number.isSafeInteger(timeout)) throw new Error("timeout 超出有效范围");
    }
    if (values.gpus !== undefined) {
      if (!/^\d+(,\d+)*$/.test(values.gpus)) throw new Error("gpus 格式为逗号分隔的非负整数");
      gpus = values.gpus.split(",").map(Number);
      if (!gpus.every(Number.isSafeInteger)) throw new Error("gpus 超出有效范围");
    }
    const run = values.agent !== undefined
      ? AgentRun.parse({ kind: "agent", engine: values.agent, prompt: positionals[1],
        ...(values.model ? { model: values.model } : {}), ...(values.session ? { session: { id: values.session, resume: Boolean(values.resume) } } : {}) })
      : { kind: "command" as const, argv: args.slice(split + 1) };
    result = await client.submitJob({ runtime: values.runtime!, run,
      ...(values.workdir !== undefined ? { workdir: values.workdir } : {}), ...(timeout !== undefined ? { timeout_seconds: timeout } : {}), ...(gpus ? { gpus } : {}) });
  } else if (action === "list") {
    const status = values.status === undefined ? undefined : JobStatus.parse(values.status);
    result = await client.jobs(status);
  } else result = await (action === "cancel" ? client.cancelJob : client.job)(id!);
  if (values.json) log(JSON.stringify(result));
  else {
    const runtimes = new Map((await client.runtimes()).map((r) => [r.actor, r]));
    for (const job of Array.isArray(result) ? result : [result]) {
      const runtime = runtimes.get(job.spec.runtime);
      log(`${job.spec.id}  ${job.status}  ${runtime?.registration.name ?? job.spec.runtime}${runtime?.online === false ? "  执行器失联" : ""}`);
      if (action === "show") {
        const r = job.result;
        if (job.spec.run.kind === "agent") log(`agent：${job.spec.run.engine}${r?.engine ? ` ${r.engine.version}（隔离：${r.engine.sandbox === "os" ? "系统沙箱" : "无沙箱"}）` : ""}`);
        if (r?.question) log(`问题：${r.question}`);
        if (r?.git) log(`git：${r.git.before?.commit.slice(0, 8) ?? "—"} → ${r.git.after?.commit.slice(0, 8) ?? "—"}${r.git.after?.dirty ? "（有未提交的改动）" : ""}`);
        if (r?.error) log(`错误：${r.error}`);
        log(JSON.stringify(job, null, 2));
      }
    }
  }
  return 0;
}
