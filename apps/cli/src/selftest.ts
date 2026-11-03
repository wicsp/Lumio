import { errorMessage, text as msg } from "./messages.ts";
import { language } from "@lumio/platform";
import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { AGENTS, WorkCommandRequest, type AgentRun, type Job } from "@lumio/schema";
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
const safety = () => msg("selftest.this_is_a_lumio_selftest_do_not_create_modify_or_delete_files_run_co");
export async function selftest(options: SelftestOptions): Promise<SelftestResult[]> {
  const now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep;
  const timeout = options.timeoutMs ?? 300_000, cancelMs = options.cancelMs ?? 30_000, poll = options.pollMs ?? 500;
  let requestDeadline = Infinity;
  const client = createClient({ language: language(), url: options.url, token: options.token, fetch: timedFetch(options.fetch, () => requestDeadline - now()) });
  const results: SelftestResult[] = [];
  const record = (r: SelftestResult) => { results.push(r); options.onResult?.(r); };
  const started = now();
  let runtime: Awaited<ReturnType<typeof client.runtimes>>[number], engines: AgentRun["engine"][];
  try {
    const runtimes = await client.runtimes();
    const selected = options.runtime ? runtimes.find((r) => r.registration.name === options.runtime) : runtimes.length === 1 ? runtimes[0] : undefined;
    if (!selected) throw new SelftestError(msg("selftest.specify_a_registered_runtime_with_runtime"));
    if (!selected.online) throw new SelftestError(msg("selftest.runtime_is_offline_run_lumio_runtime_doctor"));
    runtime = selected;
    const names = options.agents ?? selected.registration.engines.map((e) => e.name);
    if (!names.length || names.some((n) => !AGENTS.includes(n as AgentRun["engine"]) || !selected.registration.engines.some((e) => e.name === n))) throw new SelftestError(msg("selftest.selected_agent_is_not_registered_run_lumio_doctor"));
    engines = [...new Set(names)] as AgentRun["engine"][];
  } catch (cause) {
    record({ name: msg("selftest.select_runtime_and_agent"), ok: false, elapsed_ms: now() - started,
      problem: cause instanceof SelftestError ? errorMessage(cause) : msg("selftest.could_not_read_runtime_list"), fix: msg("selftest.run_lumio_doctor") }); return results;
  }
  async function wait(id: string, deadline: number, predicate = final): Promise<Job> {
    while (now() < deadline) {
      const job = await client.job(id);
      if (predicate(job)) return job;
      if (final(job)) throw new SelftestError(msg("selftest.ended_early", job.status));
      await sleep(Math.min(poll, Math.max(1, deadline - now())));
    }
    throw new SelftestError(msg("selftest.timed_out_waiting_for_result"));
  }
  const send = (op: string, args: Record<string, unknown>) => client.workCommand(WorkCommandRequest.parse({ request_id: randomUUID(), operation: { op, args } }));
  for (const engine of engines) {
    const secret = `lumio-${randomBytes(12).toString("hex")}`;
    let task: string | undefined, session: string | undefined;
    for (const step of [msg("selftest.execution_and_report"), msg("selftest.resume_session"), msg("selftest.question"), msg("selftest.cancel")] as const) {
      const begin = now(), deadline = begin + timeout;
      requestDeadline = deadline;
      let id: string | undefined, finished = false;
      try {
        if (step === msg("selftest.resume_session") && !session) throw new SelftestError(msg("selftest.round_1_did_not_return_session_id"));
        const prompt = step === msg("selftest.execution_and_report") ? msg("selftest.remember_the_passphrase_reply_only_ok", secret)
          : step === msg("selftest.resume_session") ? msg("selftest.what_is_the_passphrase_reply_only_with_the_passphrase")
          : step === msg("selftest.question") ? msg("selftest.ask_me_a_question_using_only_lumio_question_are_you_ready_lumio_ques")
          : msg("selftest.wait_120_seconds_before_replying_ok_you_may_run_a_sleep_command_that");
        if (!task) {
          const created = await send("work.task.create", { title: msg("selftest.lumio_selftest", engine, new Date(now()).toISOString()),
            description: safety() + prompt, assignee: `${engine}@${runtime.registration.name}`, workdir: "~", timeout_minutes: Math.max(1, Math.ceil(timeout / 60_000)) });
          if (created.kind !== "task") throw new SelftestError(msg("selftest.database_selftest_task_was_not_created"));
          task = created.task.id;
        } else {
          const current = await client.workTask(task);
          await send("work.task.update", { task, expected_revision: current.task.revision, patch: { description: safety() + prompt } });
        }
        const current = await client.workTask(task);
        const dispatched = await send("work.task.dispatch", { task, expected_revision: current.task.revision });
        if (dispatched.kind !== "job") throw new SelftestError(msg("selftest.database_dispatch_job_was_not_received"));
        const job = dispatched.job; id = job.spec.id;
        if (step === msg("selftest.resume_session") && (job.spec.run.kind !== "agent" || !job.spec.run.session?.resume || job.spec.run.session.id !== session)) throw new SelftestError(msg("selftest.round_2_did_not_resume_the_original_session"));
        let result: Job;
        if (step === msg("selftest.cancel")) {
          await wait(id, deadline, (j) => j.status === "running");
          const cancelled = now(); requestDeadline = Math.min(deadline, cancelled + cancelMs);
          await client.cancelJob(id);
          result = await wait(id, Math.min(deadline, cancelled + cancelMs));
          if (result.status !== "cancelled" || result.result?.status !== "cancelled" || !result.result.started || now() - cancelled > cancelMs) throw new SelftestError(msg("selftest.runtime_did_not_return_cancellation_within_30_seconds"));
        } else result = await wait(id, deadline);
        finished = true;
        if (step === msg("selftest.execution_and_report")) {
          if (result.status !== "done" || !result.result?.report?.trim()) throw new SelftestError(msg("selftest.no_successful_report_received", result.status));
          session = result.result.session_id;
        } else if (step === msg("selftest.resume_session")) {
          if (result.status !== "done" || !result.result?.report?.includes(secret)) throw new SelftestError(msg("selftest.report_did_not_contain_round_1_passphrase"));
        } else if (step === msg("selftest.question") && (result.status !== "waiting_for_human" || !result.result?.question?.trim())) throw new SelftestError(msg("selftest.no_waiting_for_human_and_question_received"));
        const detail = await client.workTask(task);
        if (!detail.executions.some(execution => execution.job === id && execution.applied) || !detail.comments.some(comment => comment.author === job.spec.runtime)) throw new SelftestError(msg("selftest.result_was_not_recorded_in_database_task_progress"));
        record({ name: `${engine} ${step}`, ok: true, elapsed_ms: now() - begin, job: id });
      } catch (cause) {
        record({ name: `${engine} ${step}`, ok: false, elapsed_ms: now() - begin, ...(id ? { job: id, fix: msg("selftest.run_lumio_job_show", id) } : {}),
          problem: cause instanceof SelftestError ? errorMessage(cause) : now() >= requestDeadline ? msg("selftest.timed_out_waiting_for_result") : msg("selftest.hub_request_failed") });
      } finally {
        requestDeadline = now() + 10_000;
        if (id && !finished) { try { await client.cancelJob(id); } catch { /* preserve the original failure */ } }
      }
    }
    if (task) {
      try {
        const current = await client.workTask(task);
        await send("work.task.update", { task, expected_revision: current.task.revision, patch: { status: "done" } });
      } catch { record({ name: msg("selftest.selftest_task_cleanup", engine), ok: false, elapsed_ms: now() - started, problem: msg("selftest.could_not_mark_database_selftest_task_as_done"), fix: msg("selftest.after_checking_run_lumio_task_status_done", task) }); }
    }
  }
  return results;
}
export async function runSelftest(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    runtime: { type: "string" }, agents: { type: "string" }, notes: { type: "boolean" }, json: { type: "boolean" },
  } });
  if (positionals.length) throw new SelftestError(msg("selftest.usage_lumio_selftest_runtime_name_agents_codex_claude_code_pi_notes"));
  let config: ReturnType<typeof readCliConfig>;
  try { config = readCliConfig(); hubCredentials(config); }
  catch {
    const failed: SelftestResult[] = [{ name: msg("selftest.selftest_configuration"), ok: false, elapsed_ms: 0, problem: msg("selftest.configuration_missing_or_could_not_be_parsed"), fix: msg("selftest.run_lumio_doctor") }];
    return printChecks(failed, Boolean(values.json), log);
  }
  const results = await selftest({ ...hubCredentials(config), runtime: values.runtime, agents: values.agents?.split(","), notes: values.notes, vault: config.vault,
    onResult: values.json ? undefined : (r) => log(msg("selftest.seconds", r.ok ? "✓" : "✗", r.name, (r.elapsed_ms / 1000).toFixed(1), r.job ? ` ${r.job}` : "", r.problem ? `：${r.problem}` : "", r.fix ? ` → ${r.fix}` : "")) });
  if (values.json) return printChecks(results, true, log);
  log(msg("selftest.checks_passed", results.filter((r) => r.ok).length, results.length));
  return results.every((r) => r.ok) ? 0 : 1;
}
