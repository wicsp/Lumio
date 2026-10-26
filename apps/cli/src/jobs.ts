import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { JobStatus, type Job } from "@lumio/schema";

const usage = "用法：lumio job submit --runtime <名称> [--workdir 路径] [--timeout 30m] [--gpus 0,1] -- <程序> [参数…]；lumio job list [--status 状态] [--json]；lumio job show <job> [--json]；lumio job cancel <job>";
export async function runJobs(args: string[], log: (line: string) => void) {
  const split = args.indexOf("--");
  const { values, positionals } = parseArgs({ args: split < 0 ? args : args.slice(0, split), allowPositionals: true, strict: true, options: {
    runtime: { type: "string" }, workdir: { type: "string" }, timeout: { type: "string" }, gpus: { type: "string" }, status: { type: "string" }, json: { type: "boolean" },
  } });
  const [action, id] = positionals;
  const keys = Object.keys(values);
  if (action === "submit") {
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
    result = await client.submitJob({ runtime: values.runtime!, run: { kind: "command", argv: args.slice(split + 1) },
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
        log(JSON.stringify(job, null, 2));
      }
    }
  }
  return 0;
}
