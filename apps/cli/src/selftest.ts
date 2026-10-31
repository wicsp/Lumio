import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { newId, parseFrontmatter, setFields, VAULT_LAYOUT, saveNewNote, writeFileAtomic, vaultFileAt } from "@lumio/core";
import { AGENTS, Task, type AgentRun, type Job } from "@lumio/schema";
import { hubCredentials, readCliConfig } from "./config.ts";
import { printChecks, timedFetch, type Check } from "./diagnostics.ts";

export interface SelftestResult extends Check { elapsed_ms: number; job?: string }
export interface SelftestOptions {
  url: string; token: string; runtime?: string; agents?: string[]; notes?: boolean; vault?: string;
  fetch?: typeof globalThis.fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number; cancelMs?: number; pollMs?: number;
  onResult?: (result: SelftestResult) => void;
}
class SelftestError extends Error { readonly code = "SELFTEST_FAILED"; }
const final = (job: Job) => ["done", "waiting_for_human", "failed", "unknown", "cancelled"].includes(job.status);
const safety = "这是 Lumio 自检。不要创建、修改或删除任何文件，不要运行写文件的命令，不要提权。只按下面要求回复。\n";
export async function selftest(options: SelftestOptions): Promise<SelftestResult[]> {
  const now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep;
  const timeout = options.timeoutMs ?? 300_000, cancelMs = options.cancelMs ?? 30_000, poll = options.pollMs ?? 500;
  let requestDeadline = Infinity;
  const client = createClient({ url: options.url, token: options.token, fetch: timedFetch(options.fetch, () => requestDeadline - now()) });
  const results: SelftestResult[] = [];
  const record = (r: SelftestResult) => { results.push(r); options.onResult?.(r); };
  const started = now();
  let runtime: Awaited<ReturnType<typeof client.runtimes>>[number], engines: AgentRun["engine"][];
  try {
    const runtimes = await client.runtimes();
    const selected = options.runtime ? runtimes.find((r) => r.registration.name === options.runtime) : runtimes.length === 1 ? runtimes[0] : undefined;
    if (!selected) throw new SelftestError("请用 --runtime 指定一个已登记的执行器");
    if (!selected.online) throw new SelftestError("执行器离线，请运行 lumio-runtime doctor");
    runtime = selected;
    const names = options.agents ?? selected.registration.engines.map((e) => e.name);
    if (!names.length || names.some((n) => !AGENTS.includes(n as AgentRun["engine"]) || !selected.registration.engines.some((e) => e.name === n))) throw new SelftestError("所选 agent 未登记；请运行 lumio doctor");
    engines = [...new Set(names)] as AgentRun["engine"][];
  } catch (cause) {
    record({ name: "选择执行器与 agent", ok: false, elapsed_ms: now() - started,
      problem: cause instanceof SelftestError ? cause.message : "无法读取执行器列表", fix: "运行 lumio doctor" }); return results;
  }
  async function wait(id: string, deadline: number, predicate = final): Promise<Job> {
    while (now() < deadline) {
      const job = await client.job(id);
      if (predicate(job)) return job;
      if (final(job)) throw new SelftestError(`提前结束：${job.status}`);
      await sleep(Math.min(poll, Math.max(1, deadline - now())));
    }
    throw new SelftestError("等待结果超时");
  }
  for (const engine of engines) {
    const secret = `lumio-${randomBytes(12).toString("hex")}`;
    let session = engine === "claude-code" ? randomUUID() : engine === "pi" ? `selftest-${randomUUID()}` : undefined;
    for (const step of ["执行与汇报", "接着会话", "提问", "取消"] as const) {
      const begin = now(), deadline = begin + timeout;
      requestDeadline = deadline;
      let id: string | undefined, finished = false;
      try {
        if (step === "接着会话" && !session) throw new SelftestError("第 1 轮没有返回 session_id");
        const prompt = step === "执行与汇报" ? `记住暗号 ${secret}，只回复 OK。`
          : step === "接着会话" ? "暗号是什么？只回复暗号。"
          : step === "提问" ? "请只用 <lumio-question>你准备好了吗？</lumio-question> 问我一个问题。"
          : "等待 120 秒再回复 OK。可以使用只等待的 sleep 命令，不要提前结束。";
        const job = await client.submitJob({ runtime: runtime.registration.name, workdir: "~", timeout_seconds: Math.max(1, Math.ceil(timeout / 1000)),
          run: { kind: "agent", engine, prompt: safety + prompt,
            ...(step === "执行与汇报" && session ? { session: { id: session, resume: false } }
              : step === "接着会话" ? { session: { id: session!, resume: true } } : {}) } });
        id = job.spec.id;
        let result: Job;
        if (step === "取消") {
          // Wait for a real running job; cancelling the Hub queue alone doesn't exercise the executor.
          await wait(id, deadline, (j) => j.status === "running");
          const cancelled = now();
          requestDeadline = Math.min(deadline, cancelled + cancelMs);
          await client.cancelJob(id);
          result = await wait(id, Math.min(deadline, cancelled + cancelMs));
          if (result.status !== "cancelled" || result.result?.status !== "cancelled" || !result.result.started || now() - cancelled > cancelMs) throw new SelftestError("执行器未在 30 秒内交回取消结果");
        } else result = await wait(id, deadline);
        finished = true;
        if (step === "执行与汇报") {
          if (result.status !== "done" || !result.result?.report?.trim()) throw new SelftestError(`未收到成功汇报（${result.status}）`);
          if (engine === "codex") session = result.result.session_id;
        } else if (step === "接着会话") {
          if (result.status !== "done" || !result.result?.report?.includes(secret)) throw new SelftestError("汇报未包含第 1 轮暗号");
        } else if (step === "提问" && (result.status !== "waiting_for_human" || !result.result?.question?.trim())) throw new SelftestError("未收到 waiting_for_human 与 question");
        record({ name: `${engine} ${step}`, ok: true, elapsed_ms: now() - begin, job: id });
      } catch (cause) {
        record({ name: `${engine} ${step}`, ok: false, elapsed_ms: now() - begin, ...(id ? { job: id, fix: `运行 lumio job show ${id}` } : {}),
          problem: cause instanceof SelftestError ? cause.message : now() >= requestDeadline ? "等待结果超时" : "Hub 请求失败" });
      } finally {
        requestDeadline = now() + 10_000;
        if (id && !finished) { try { await client.cancelJob(id); } catch { /* reported above; never mask later steps */ } }
      }
    }
  }
  if (options.notes) {
    const begin = now(); requestDeadline = begin + timeout; let id: string | undefined, notePath: string | undefined, noteTask: string | undefined;
    try {
      if (!options.vault) throw new SelftestError("--notes 需要本机 vault 配置，请在 Hub 所在机器运行");
      const date = new Date(), title = `Lumio 自检 ${date.toISOString().replaceAll(":", "-")}`;
      const task = newId("task", date, randomBytes), engine = engines[0]!;
      const data = Task.parse({ id: task, type: "task", title, created: date.toISOString(), updated: date.toISOString(), status: "todo",
        assignee: `${engine}@${runtime.registration.name}` });
      const dir = VAULT_LAYOUT.find((d) => d.type === "task")!.dir;
      const relative = join(dir, `${title}-${task}.md`);
      const path = join(options.vault, relative);
      const fields = Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
      await saveNewNote(options.vault, { relativePath: relative, content: Buffer.from(`---\n${fields}\n---\n\n来源：lumio selftest --notes 自动创建的自检任务。\n\n${safety}只回复 OK。\n`) });
      notePath = relative; noteTask = task;
      const deadline = begin + timeout;
      let content: string | undefined;
      while (now() < deadline) {
        const jobs = await client.jobs(undefined, task);
        const first = jobs[0]; id = first?.spec.id;
        const text = await readFile(path, "utf8"), note = parseFrontmatter(text);
        if (note.data.assignee === "human" && text.includes("<!-- lumio:ai start name=round-1") && text.includes("### 第 1 轮")) {
          if (first?.status !== "done" || !first.result?.report?.trim()) throw new SelftestError("笔记第 1 轮没有成功汇报");
          content = text; break;
        }
        if (first && final(first) && first.status !== "done") throw new SelftestError(`笔记第 1 轮失败（${first.status}）`);
        await sleep(poll);
      }
      if (!content) throw new SelftestError("等待笔记派活或写回超时");
      // Only the selftest-created note is edited, after Hub has handed the turn back.
      if (await readFile(path, "utf8") !== content) throw new SelftestError("自检笔记被并发修改，请检查后手动标为 done");
      await writeFileAtomic(path, setFields(Buffer.from(content), { status: "done" }), { expectedContent: Buffer.from(content) });
      record({ name: "笔记派活与写回", ok: true, elapsed_ms: now() - begin, job: id });
    } catch (cause) {
      record({ name: "笔记派活与写回", ok: false, elapsed_ms: now() - begin, ...(id ? { job: id, fix: `运行 lumio job show ${id}` } : {}),
        problem: cause instanceof SelftestError ? cause.message : "无法创建或检查自检笔记" });
      requestDeadline = now() + 10_000;
      if (id) { try { await client.cancelJob(id); } catch { /* keep diagnostics */ } }
      // A timed-out pending note must not dispatch after selftest has returned.
      if (notePath && noteTask && options.vault) {
        try {
          const file = await vaultFileAt(options.vault, notePath);
          if (!file) throw new Error();
          const bytes = await readFile(file.path);
          if (parseFrontmatter(bytes).data.id !== noteTask) throw new Error();
          await writeFileAtomic(file.path, setFields(bytes, { status: "done", assignee: "human" }), { expectedContent: bytes });
        } catch {
          record({ name: "自检笔记清理", ok: false, elapsed_ms: now() - begin, problem: "无法标记自检笔记完成", fix: "检查自检笔记后手动设 status: done、assignee: human" });
        }
      }
    }
  }
  return results;
}
export async function runSelftest(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    runtime: { type: "string" }, agents: { type: "string" }, notes: { type: "boolean" }, json: { type: "boolean" },
  } });
  if (positionals.length) throw new SelftestError("用法：lumio selftest [--runtime 名称] [--agents codex,claude-code,pi] [--notes] [--json]");
  let config: ReturnType<typeof readCliConfig>;
  try { config = readCliConfig(); hubCredentials(config); }
  catch {
    const failed: SelftestResult[] = [{ name: "自检配置", ok: false, elapsed_ms: 0, problem: "配置缺失或无法解析", fix: "运行 lumio doctor" }];
    return printChecks(failed, Boolean(values.json), log);
  }
  const results = await selftest({ ...hubCredentials(config), runtime: values.runtime, agents: values.agents?.split(","), notes: values.notes, vault: config.vault,
    onResult: values.json ? undefined : (r) => log(`${r.ok ? "✓" : "✗"} ${r.name}（${(r.elapsed_ms / 1000).toFixed(1)} 秒）${r.job ? ` ${r.job}` : ""}${r.problem ? `：${r.problem}` : ""}${r.fix ? ` → ${r.fix}` : ""}`) });
  if (values.json) return printChecks(results, true, log);
  log(`${results.filter((r) => r.ok).length}/${results.length} 项通过`);
  return results.every((r) => r.ok) ? 0 : 1;
}
