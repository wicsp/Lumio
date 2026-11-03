import { language } from "@lumio/platform";
import { text as msg } from "./messages.ts";
import { hubCredentials } from "./config.ts";
import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { AgentRun, JobStatus, type Job } from "@lumio/schema";
import { createHash } from "node:crypto";
import { link, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const usage = () => msg("jobs.usage_lumio_job_submit_runtime_name_workdir_path_timeout_30m_gpus_0") +
  msg("jobs.lumio_job_submit_runtime_name_agent_codex_claude_code_pi_model_model");
export async function runJobs(args: string[], log: (line: string) => void) {
  const split = args.indexOf("--");
  const { values, positionals } = parseArgs({ args: split < 0 ? args : args.slice(0, split), allowPositionals: true, strict: true, options: {
    runtime: { type: "string" }, workdir: { type: "string" }, timeout: { type: "string" }, gpus: { type: "string" }, status: { type: "string" }, json: { type: "boolean" },
    agent: { type: "string" }, model: { type: "string" }, session: { type: "string" }, resume: { type: "boolean" },
    output: { type: "string" }, "include-private": { type: "boolean" },
  } });
  const [action, id] = positionals;
  const keys = Object.keys(values);
  const agentKeys = ["agent", "model", "session", "resume"];
  if (action === "artifacts" || action === "download") {
    if (positionals.length !== 2 || split >= 0 || (action === "download" && !values.output)
      || keys.some((key) => !["json", "include-private", ...(action === "download" ? ["output"] : [])].includes(key))) throw new Error(msg("jobs.usage_lumio_job_artifacts_job_id_json_lumio_job_download_file_id_out"));
    const client = createClient({ ...hubCredentials(), language: language() }), query = { includePrivate: values["include-private"] };
    if (action === "artifacts") {
      const files = await client.jobArtifacts(id!, query);
      if (values.json) log(JSON.stringify(files));
      else { if (!files.length) log(msg("jobs.no_logs_or_artifacts_registered")); for (const file of files) log(msg("jobs.bytes", file.id, file.status === "ready" ? msg("jobs.archived") : msg("jobs.waiting_for_file_upload"), file.media_type, file.size)); }
      return 0;
    }
    const metadata = await client.artifact(id!, query), response = await client.artifactContent(id!, query);
    const target = resolve(values.output!), directory = await mkdtemp(join(dirname(target), ".lumio-download-")), temporary = join(directory, "content");
    try {
      const handle = await open(temporary, "wx", 0o600), hash = createHash("sha256"); let size = 0;
      try {
        if (!response.body) throw new Error(msg("jobs.file_response_has_no_body"));
        const reader = response.body.getReader();
        try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > metadata.size) throw new Error(msg("jobs.file_size_does_not_match_registration")); hash.update(chunk.value); await handle.writeFile(chunk.value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (size !== metadata.size || hash.digest("hex") !== metadata.sha256) throw new Error(msg("jobs.file_checksum_failed_file_was_not_saved"));
        await handle.sync();
      } finally { await handle.close(); }
      await link(temporary, target);
      log(values.json ? JSON.stringify(metadata) : msg("jobs.verified_and_saved", target)); return 0;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (action === "submit" && values.agent !== undefined) {
    // agent 类型：要求是唯一的位置参数，不用 --。
    if (positionals.length !== 2 || split >= 0 || !positionals[1] || !values.runtime || (values.resume && !values.session)
      || keys.some((k) => !["runtime", "workdir", "timeout", "gpus", "json", ...agentKeys].includes(k))) throw new Error(usage());
  } else if (action === "submit") {
    if (positionals.length !== 1 || split < 0 || !args[split + 1] || !values.runtime || keys.some((k) => !["runtime", "workdir", "timeout", "gpus", "json"].includes(k))) throw new Error(usage());
  } else if (action === "list") {
    if (positionals.length !== 1 || split >= 0 || keys.some((k) => !["status", "json"].includes(k))) throw new Error(usage());
  } else if (action === "show" || action === "cancel") {
    if (positionals.length !== 2 || split >= 0 || keys.some((k) => k !== "json")) throw new Error(usage());
  } else throw new Error(usage());
  const { url, token } = hubCredentials();
  const client = createClient({ language: language(), url, token });
  let result: Job | Job[];
  if (action === "submit") {
    let timeout: number | undefined, gpus: number[] | undefined;
    if (values.timeout !== undefined) {
      const match = /^([1-9]\d*)(s|m|h)$/.exec(values.timeout);
      if (!match) throw new Error(msg("jobs.timeout_must_be_a_positive_integer_followed_by_s_m_or_h_e_g_30m"));
      timeout = Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2]!]!);
      if (!Number.isSafeInteger(timeout)) throw new Error(msg("jobs.timeout_is_out_of_range"));
    }
    if (values.gpus !== undefined) {
      if (!/^\d+(,\d+)*$/.test(values.gpus)) throw new Error(msg("jobs.gpus_must_be_comma_separated_non_negative_integers"));
      gpus = values.gpus.split(",").map(Number);
      if (!gpus.every(Number.isSafeInteger)) throw new Error(msg("jobs.gpus_is_out_of_range"));
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
      log(`${job.spec.id}  ${job.status}  ${runtime?.registration.name ?? job.spec.runtime}${runtime?.online === false ? msg("jobs.runtime_disconnected") : ""}`);
      if (action === "show") {
        const r = job.result;
        if (job.spec.run.kind === "agent") log(`agent：${job.spec.run.engine}${r?.engine ? msg("jobs.isolation", r.engine.version, r.engine.sandbox === "os" ? msg("jobs.os_sandbox") : msg("jobs.no_sandbox")) : ""}`);
        if (r?.question) log(msg("jobs.question", r.question));
        if (r?.git) log(`git：${r.git.before?.commit.slice(0, 8) ?? "—"} → ${r.git.after?.commit.slice(0, 8) ?? "—"}${r.git.after?.dirty ? msg("jobs.uncommitted_changes") : ""}`);
        if (r?.error) log(msg("jobs.error", r.error));
        log(JSON.stringify(job, null, 2));
      }
    }
  }
  return 0;
}
