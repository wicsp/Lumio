import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  createIdea, createPaper, generateCitekey, newId, parseArxivMetadata,
  parseCrossrefMetadata, parsePaperInput, resolveVault,
} from "@lumio/core";
import { ApiClientError, createClient } from "@lumio/api-client";
import { ApiError } from "@lumio/schema";
import { runOperations } from "./operations.ts";
import { version } from "../package.json";
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
    if (!["link", "propose", "proposals"].includes(args[0] ?? "") || !args.includes("--json")) throw cause;
    const error = cause instanceof ApiClientError ? {
      code: cause.code, message: cause.message, operation: cause.operation, reason: cause.reason, proposal: cause.proposal,
    } : { code: "INVALID", message: cause instanceof Error ? cause.message : "无法执行命令" };
    (options.log ?? console.log)(JSON.stringify(ApiError.parse({ error })));
    return 1;
  }
}

async function executeCli(args: string[], options: CliOptions): Promise<number> {
  const log = options.log ?? console.log;
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
  if (["link", "propose", "proposals"].includes(command ?? "")) {
    if (Object.keys(values).some((key) => !["reason", "status", "json"].includes(key))) throw new Error("链接与提议命令不支持此选项");
    return runOperations(positionals, values, log);
  }
  if (values.reason !== undefined || values.status !== undefined) throw new Error("reason 和 status 只用于链接与提议命令");
  if (command === "hub" && positionals[1] === "status") {
    if (positionals.length !== 2 || Object.keys(values).length) throw new Error("用法：lumio hub status");
    const url = process.env.LUMIO_HUB_URL, token = process.env.LUMIO_TOKEN;
    if (!url || !token) throw new Error("hub status 需要设置非空的 LUMIO_HUB_URL 和 LUMIO_TOKEN");
    const endpoint = new URL(url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("LUMIO_HUB_URL 必须是 HTTP(S) 地址");
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/v1/status`;
    endpoint.search = ""; endpoint.hash = "";
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
    if (!response.ok) throw new Error(`无法获取 Hub 状态（HTTP ${response.status}）`);
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
      throw new Error("用法：lumio search <查询> [--type 类型] [--limit N] [--include-private] [--json]；lumio show|links <引用> [--include-private] [--json]；lumio check [--include-private] [--json]；lumio export bib [--from 引用] [--out 路径]");
    }
    const url = process.env.LUMIO_HUB_URL;
    const token = process.env.LUMIO_TOKEN;
    if (query && ((url !== undefined) !== (token !== undefined) || url === "" || token === "")) {
      throw new Error("远程查询需要同时设置非空的 LUMIO_HUB_URL 和 LUMIO_TOKEN");
    }
    const remote = query && url && token ? createClient({ url, token }) : undefined;
    return runQuery(remote ? undefined : resolveVault(values.vault, process.env.LUMIO_VAULT), {
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
    throw new Error("用法：lumio sync [--vault <路径>] [--dry-run]；lumio new idea <标题> [--vault <路径>]；lumio new paper <输入> [--vault <路径>] [--abbr <缩写>]");
  }
  const root = resolveVault(values.vault, process.env.LUMIO_VAULT);
  const now = new Date();
  const ctx = {
    now, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    newId: (prefix: Parameters<typeof newId>[0]) => newId(prefix, now, randomBytes),
  };
  if (paper) {
    const input = parsePaperInput(positionals[2]!);
    const source = await fetchPaperSource(input, {
      version, fetcher: options.fetcher, contactEmail: process.env.LUMIO_CONTACT_EMAIL,
    });
    const metadata = source.kind === "arxiv" ? parseArxivMetadata(source.metadata) : parseCrossrefMetadata(source.metadata);
    if (input.kind === "arxiv" && metadata.arxiv !== input.id) throw new Error("arXiv API 返回的论文 ID 与输入不一致");
    if (input.kind === "doi") {
      if (metadata.doi && metadata.doi.toLowerCase() !== input.doi.toLowerCase()) throw new Error("Crossref 返回的 DOI 与输入不一致");
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
