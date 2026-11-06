import { KnowledgeCreateRequest, KnowledgeTemplateRequest, PaperResolveRequest, PaperResolveResult } from "@lumio/schema";
import { randomBytes } from "node:crypto";
import { CoreError, newId } from "@lumio/foundation";
import { knowledgeTemplate, parsePaperInput, parseArxivMetadata, parseCrossrefMetadata, generateCitekey, rewriteBibtexKey } from "@lumio/knowledge";
import { KnowledgeCreationStore, updateIndex, openVaultGit } from "@lumio/storage";
import { HubError } from "./errors.ts";
import { text as msg, withLanguage } from "./messages.ts";
import { containsSecret } from "./tasks.ts";
import type { HubConfig } from "./config.ts";
import type { HubStore, Identity } from "./store.ts";
import type { authorize } from "./authorize.ts";

export const KNOWLEDGE_ROUTES = [
  { operation: "knowledge.template", method: "GET", pattern: /^\/v2\/knowledge\/templates$/ },
  { operation: "knowledge.resolve", method: "POST", pattern: /^\/v2\/knowledge\/papers\/resolve$/ },
  { operation: "knowledge.create", method: "POST", pattern: /^\/v2\/knowledge\/notes$/ },
] as const;
type Operation = typeof KNOWLEDGE_ROUTES[number]["operation"];
export type PaperFetch = (url: string, init: RequestInit) => Promise<Response>;

async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new Error("BODY_LIMIT"); chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Only fixed scholarly providers; redirects are checked before any next request. */
export async function resolvePaper(input: PaperResolveRequest, fetcher: PaperFetch = fetch, timeoutMs = 15000): Promise<PaperResolveResult> {
  let source: ReturnType<typeof parsePaperInput>;
  try { source = parsePaperInput(input.input); }
  catch { throw new HubError("INVALID", { key: "knowledge.paper_input", args: [] }, { reason: "invalid-paper-input" }); }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("TIMEOUT")); }, timeoutMs); });
  const allowed = new Set(["export.arxiv.org", "arxiv.org", "api.crossref.org", "doi.org"]);
  const request = async (initial: string, accept: string): Promise<string> => {
    let url = new URL(initial);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (url.protocol !== "https:" || url.port || url.username || url.password || !allowed.has(url.hostname)) throw new Error("UNSUPPORTED_REDIRECT");
      const response = await fetcher(url.href, { redirect: "manual", signal: controller.signal, headers: { Accept: accept, "User-Agent": "Lumio/knowledge-authoring" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel(); const next = response.headers.get("location"); if (!next) throw new Error("MISSING_LOCATION"); url = new URL(next, url); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error("UPSTREAM_FAILED"); }
      if (Number(response.headers.get("content-length")) > 2_000_000) { await response.body?.cancel(); throw new Error("BODY_LIMIT"); }
      return boundedText(response.body, 2_000_000);
    }
    throw new Error("REDIRECT_LIMIT");
  };
  try {
    return await Promise.race([timeout, (async () => {
      const raw = source.kind === "arxiv"
        ? await request(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(source.id)}`, "application/atom+xml")
        : await request(`https://api.crossref.org/works/${encodeURIComponent(source.doi)}`, "application/json");
      const metadata = source.kind === "arxiv" ? parseArxivMetadata(raw) : parseCrossrefMetadata(JSON.parse(raw));
      // Upstream identity must correspond to the requested paper.
      const identity = parsePaperInput(source.kind === "arxiv" ? metadata.arxiv ?? "" : metadata.doi ?? "");
      if (JSON.stringify(identity).toLowerCase() !== JSON.stringify(source).toLowerCase()) throw new Error("IDENTITY_MISMATCH");
      let bibtex: string | undefined;
      try {
        const rawBib = await request(source.kind === "arxiv" ? `https://arxiv.org/bibtex/${source.id}`
          : `https://api.crossref.org/works/${encodeURIComponent(source.doi)}/transform/application/x-bibtex`, "application/x-bibtex");
        bibtex = rewriteBibtexKey(rawBib, generateCitekey(metadata));
      } catch { if (controller.signal.aborted) throw new Error("TIMEOUT"); /* Metadata can still be confirmed without a BibTeX response. */ }
      const result = PaperResolveResult.parse({ ...metadata, ...(bibtex ? { bibtex } : {}) });
      if (containsSecret(JSON.stringify(result))) throw new Error("UNSAFE_METADATA");
      return result;
    })()]);
  } catch { throw new HubError("INVALID", { key: "knowledge.paper_failed", args: [] }, { reason: "paper-resolution-failed" }); }
  finally { clearTimeout(timer!); controller.abort(); }
}

export class KnowledgeAuthoring {
  private creations?: KnowledgeCreationStore;
  constructor(private config: HubConfig, private store: HubStore, private exclusive: <T>(action: () => Promise<T>) => Promise<T>,
    private issue: (path: string, message: string) => void, private fetcher?: PaperFetch) {
    if (config.vault) this.creations = new KnowledgeCreationStore(store.db, config.vault);
  }
  async handle(request: Request, operation: Operation, identity: Identity, decide: typeof authorize, now: Date): Promise<Response> {
    const decision = decide(identity.actor, { operation });
    if (identity.actor.role !== "human" || decision.result !== "allow") {
      this.store.auditDenied(identity, operation);
      throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: "knowledge-authoring-human-only" });
    }
    if (!this.creations) throw new HubError("INVALID", { key: "knowledge.no_vault", args: [] }, { reason: "knowledge-not-configured" });
    let body: unknown;
    if (request.method === "POST") {
      try { body = JSON.parse(await boundedText(request.body, 3_000_000)); }
      catch { throw new HubError("INVALID", { key: "knowledge.invalid", args: [] }); }
    }
    if (operation === "knowledge.template") {
      const parsed = KnowledgeTemplateRequest.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!parsed.success) throw new HubError("INVALID", { key: "knowledge.invalid", args: [] });
      this.store.audit(identity, operation, "allow");
      return Response.json(withLanguage(parsed.data.locale, () => knowledgeTemplate(parsed.data, msg)));
    }
    if (operation === "knowledge.resolve") {
      const parsed = PaperResolveRequest.safeParse(body);
      if (!parsed.success) throw new HubError("INVALID", { key: "knowledge.invalid", args: [] });
      const result = await resolvePaper(parsed.data, this.fetcher);
      this.store.audit(identity, operation, "allow");
      return Response.json(result);
    }
    const parsed = KnowledgeCreateRequest.safeParse(body);
    if (!parsed.success) throw new HubError("INVALID", { key: "knowledge.invalid", args: [] }, { reason: "invalid-note" });
    try {
      const result = await this.exclusive(() => this.creations!.create(identity.actor.id, parsed.data, { now, newId: prefix => newId(prefix, now, randomBytes), tz: "UTC" }, {
        validate: note => { if (containsSecret(note.content.toString("utf8"))) throw new HubError("INVALID", { key: "knowledge.sensitive", args: [] }, { reason: "sensitive-content" }); },
        finalize: async (note, bytes) => {
          await updateIndex(this.config.vault, { stateDir: this.config.stateDir });
          const git = await openVaultGit(this.config.vault);
          if (git) try { await git.add(note.path, bytes); await git.commit([note.path], "lumio: create knowledge note", { "Lumio-Actor": identity.actor.id }); }
          catch { this.issue(note.path, msg("knowledge.commit_failed")); }
        },
        audit: note => this.store.audit(identity, operation, "allow", undefined, `created:${note.id}`),
      }));
      return Response.json(result, { status: 201 });
    } catch (cause) {
      if (cause instanceof HubError) throw cause;
      if (cause instanceof CoreError) {
        if (["FILE_EXISTS", "DUPLICATE_PAPER", "REQUEST_CONFLICT"].includes(cause.code)) throw new HubError("CONFLICT", { key: `knowledge.${cause.code.toLowerCase()}`, args: [] }, { reason: cause.code.toLowerCase() });
        if (cause.code === "NOTE_RECOVERY_CONFLICT") throw new HubError("CONFLICT", { key: "knowledge.recovery_conflict", args: [] }, { reason: "note-recovery-conflict" });
        if (["UNSAFE_NOTE_PATH", "INVALID_NOTE_DIRECTORY", "NOTE_NOT_CREATED"].includes(cause.code)) throw new HubError("INVALID", { key: "knowledge.path_failed", args: [] }, { reason: "knowledge-path-unavailable" });
        if (["INVALID_FILE_NAME", "INVALID_PAPER_INPUT", "INVALID_PAPER_YEAR", "INVALID_METADATA", "INVALID_BIBTEX"].includes(cause.code)) throw new HubError("INVALID", { key: "knowledge.invalid", args: [] }, { reason: "invalid-note" });
      }
      throw new HubError("INTERNAL", { key: "knowledge.uncertain", args: [] }, { reason: "note-save-uncertain" });
    }
  }
}
