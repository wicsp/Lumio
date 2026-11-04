import { errorMessage, text as msg } from "./messages.ts";
import { language } from "@lumio/platform";
import { doctor } from "./doctor.ts";
import { printChecks } from "./diagnostics.ts";
import { runSelftest } from "./selftest.ts";
import { runUpgrade } from "./upgrade.ts";
import { runPairing } from "./pairing.ts";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { createIdea, createPaper } from "@lumio/storage";
import { generateCitekey, parseArxivMetadata, parseCrossrefMetadata, parsePaperInput, resolveVault } from "@lumio/knowledge";
import { newId } from "@lumio/foundation";
import { ApiClientError, createClient } from "@lumio/api-client";
import { ApiError } from "@lumio/schema";
import { runAgents, runSkillInstall } from "./agent-access.ts";
import { runJobs } from "./jobs.ts";
import { runTasks } from "./tasks.ts";
import { runWork, runAttention, runPlanTemplates } from "./work.ts";
import { runAssistant } from "./assistant.ts";
import { runRoutines } from "./routines.ts";
import { runExecutionRoutines } from "./execution-routines.ts";
import { runOperations } from "./operations.ts";
import { version } from "./version.ts";
import { readCliConfig, hubCredentials, localVault } from "./config.ts";
import { syncVault } from "./sync.ts";
import { fetchPaperSource, type PaperFetcher } from "./paper-source.ts";
import { runQuery } from "./query.ts";

export interface CliOptions {
  fetcher?: PaperFetcher;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  try { return await executeCli(args, options); }
  catch (cause) {
    if (!["agent", "job", "task", "project", "plan-template", "attention", "chat", "routine", "proposals", "runtime"].includes(args[0] ?? "") || !args.includes("--json")) throw cause;
    const error = cause instanceof ApiClientError ? {
      code: cause.code, message: errorMessage(cause), operation: cause.operation, reason: cause.reason, proposal: cause.proposal,
    } : { code: "INVALID", message: cause instanceof Error ? errorMessage(cause) : msg("cli.could_not_execute_command") };
    (options.log ?? console.log)(JSON.stringify(ApiError.parse({ error })));
    return 1;
  }
}

async function executeCli(args: string[], options: CliOptions): Promise<number> {
  const log = options.log ?? console.log;
  if (args[0] === "doctor") {
    const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { json: { type: "boolean" } } });
    if (positionals.length) throw new Error(msg("cli.usage_lumio_doctor_json"));
    return printChecks(await doctor(), Boolean(values.json), log);
  }
  if (args[0] === "selftest") return runSelftest(args.slice(1), log);
  if (args[0] === "upgrade") return runUpgrade(args.slice(1), false, log);
  if (args.length === 1 && args[0] === "--version") { log(version); return 0; }
  if (["login", "login-code", "logout"].includes(args[0] ?? "") || (args[0] === "runtime" && ["add", "remove"].includes(args[1] ?? ""))) return runPairing(args, { log, warn: options.warn });
  if (args[0] === "agent") return runAgents(args.slice(1), log);
  if (args[0] === "skill") return runSkillInstall(args.slice(1), log);
  if (args[0] === "job") return runJobs(args.slice(1), log);
  if (args[0] === "attention") return runAttention(args.slice(1), log);
  if (args[0] === "plan-template") return runPlanTemplates(args.slice(1), log);
  if (args[0] === "task") return (await runWork("task", args.slice(1), log)) ?? runTasks(args.slice(1).filter((arg) => arg !== "--legacy"), log);
  if (args[0] === "project") return (await runWork("project", args.slice(1), log))!;
  if (args[0] === "chat") return runAssistant(args.slice(1), log);
  if (args[0] === "routine") return (await runExecutionRoutines(args.slice(1), log)) ?? runRoutines(args.slice(1).filter((arg) => arg !== "--legacy"), log);
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      vault: { type: "string" }, "dry-run": { type: "boolean" },
      abbr: { type: "string" }, reason: { type: "string" }, status: { type: "string" },
      type: { type: "string" }, limit: { type: "string" }, out: { type: "string" }, from: { type: "string" },
      "include-private": { type: "boolean" }, json: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (command === "runtime") {
    if (positionals.length !== 2 || positionals[1] !== "list" || Object.keys(values).some((key) => key !== "json")) {
      throw new Error(msg("cli.usage_lumio_runtime_list_json"));
    }
    const { url, token } = hubCredentials(readCliConfig({ warn: options.warn }));
    const runtimes = await createClient({ language: language(), url, token }).runtimes();
    if (values.json) log(JSON.stringify(runtimes));
    else for (const runtime of runtimes) {
      const registration = runtime.registration;
      log(msg("cli.last_seen", registration.name, runtime.online ? msg("cli.online") : msg("cli.disconnected"), runtime.last_seen, registration.engines.map((engine) => `${engine.name} ${engine.version}`).join(", "), registration.tags.join(", ")));
    }
    return 0;
  }
  if (command === "proposals") {
    if (Object.keys(values).some((key) => !["reason", "status", "json"].includes(key))) throw new Error(msg("cli.link_and_proposal_commands_do_not_support_this_option"));
    return runOperations(positionals, values, log);
  }
  if (values.reason !== undefined || values.status !== undefined) throw new Error(msg("cli.reason_and_status_are_only_for_link_and_proposal_commands"));
  if (command === "hub" && positionals[1] === "status") {
    if (positionals.length !== 2 || Object.keys(values).length) throw new Error(msg("cli.usage_lumio_hub_status"));
    const { url, token } = hubCredentials(readCliConfig({ warn: options.warn }));
    const endpoint = new URL(url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error(msg("cli.lumio_hub_url_must_be_an_http_s_url"));
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/v1/status`;
    endpoint.search = ""; endpoint.hash = "";
    const response = await fetch(endpoint, { headers: { "Accept-Language": language(), Authorization: `Bearer ${token}` }, redirect: "error" });
    if (!response.ok) throw new Error(msg("cli.could_not_get_hub_status_http", response.status));
    log(JSON.stringify(await response.json()));
    return 0;
  }

  const query = command === "search" || command === "show" || command === "links" || command === "check";
  const bib = command === "export" && positionals[1] === "bib";
  if (query || bib) {
    if (positionals.length !== (command === "check" ? 1 : 2) || values.abbr !== undefined || values["dry-run"] !== undefined
      || (!bib && (values.out !== undefined || values.from !== undefined)) || values.from === ""
      || (command !== "search" && (values.type !== undefined || values.limit !== undefined))
      || (bib && (values.json !== undefined || values["include-private"] !== undefined))) {
      throw new Error(msg("cli.usage_lumio_search_query_type_type_limit_n_include_private_json_lumi"));
    }
    const config = readCliConfig({ warn: options.warn });
    const { url, token } = config;
    if (query && ((url !== undefined) !== (token !== undefined) || url === "" || token === "")) {
      throw new Error(msg("cli.no_configuration_run_install_sh_or_lumio_hub_setup_first_remote_quer"));
    }
    const remote = query && url && token ? createClient({ language: language(), url, token }) : undefined;
    return runQuery(remote ? undefined : resolveVault(localVault(values.vault, config), undefined), {
      command: bib ? "export" : command as "search" | "show" | "links" | "check", argument: positionals[1] ?? "",
      type: values.type, limit: values.limit, out: values.out, from: values.from,
      includePrivate: values["include-private"], json: values.json,
    }, log, options.warn ?? console.error, remote);
  }
  const sync = positionals.length === 1 && positionals[0] === "sync";
  const idea = positionals.length === 3 && positionals[0] === "new" && positionals[1] === "idea";
  const paper = positionals.length === 3 && positionals[0] === "new" && positionals[1] === "paper";
  if ((!sync && !idea && !paper) || (!sync && values["dry-run"] !== undefined)
    || (!paper && values.abbr !== undefined)
    || [values.type, values.limit, values.out, values.from, values.json, values["include-private"]].some((v) => v !== undefined)) {
    throw new Error(msg("cli.usage_lumio_sync_vault_path_dry_run_lumio_new_idea_title_vault_path"));
  }
  const root = resolveVault(localVault(values.vault, readCliConfig({ warn: options.warn })), undefined);
  const now = new Date();
  const ctx = {
    text: msg, now, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    newId: (prefix: Parameters<typeof newId>[0]) => newId(prefix, now, randomBytes),
  };
  if (paper) {
    const input = parsePaperInput(positionals[2]!);
    const source = await fetchPaperSource(input, {
      version, fetcher: options.fetcher, contactEmail: process.env.LUMIO_CONTACT_EMAIL,
    });
    const metadata = source.kind === "arxiv" ? parseArxivMetadata(source.metadata) : parseCrossrefMetadata(source.metadata);
    if (input.kind === "arxiv" && metadata.arxiv !== input.id) throw new Error(msg("cli.arxiv_api_returned_a_paper_id_different_from_the_input"));
    if (input.kind === "doi") {
      if (metadata.doi && metadata.doi.toLowerCase() !== input.doi.toLowerCase()) throw new Error(msg("cli.crossref_returned_a_doi_different_from_the_input"));
      metadata.doi ??= input.doi;
    }
    log(await createPaper(root, metadata, generateCitekey(metadata, values.abbr), source.bibtex, ctx));
    return 0;
  }
  if (idea) {
    log(await createIdea(root, positionals[2]!, ctx));
    return 0;
  }
  return syncVault(root, { dryRun: values["dry-run"], log });
}
