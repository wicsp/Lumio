import { createHash, randomBytes } from "node:crypto";
import {
  CAPTURE_LIMITS, Capture, CaptureCommand, CaptureCreate, CaptureCreateResult, CaptureList, CaptureListArgs,
  KnowledgeAIBinding, KnowledgeAIBindingUpdate, type CaptureError, type NoteRef,
} from "@lumio/schema";
import { CoreError, newId } from "@lumio/foundation";
import { noteById, readKnowledgeDocument, showOriginal, type NoteTrashMove } from "@lumio/storage";
import type { AIConfigurationService } from "./ai-config.ts";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { captureKind, extractCapture, normalizeCaptureUrl } from "./inbox-extract.ts";
import { CaptureFailure, type CaptureNetwork } from "./inbox-fetch.ts";
import { InboxFiles } from "./inbox-files.ts";
import { inboxConflict, inboxMissing, InboxStore, type StoredCapture } from "./inbox-store.ts";
import { summarizeOriginal, type SummaryModel } from "./inbox-summary.ts";
import { boundedText } from "./knowledge-authoring.ts";
import { text as msg } from "./messages.ts";
import type { HubStore, Identity } from "./store.ts";
import { assertNoteVisible, type Trash, type TrashCompanion } from "./trash.ts";
import { containsSecret } from "./tasks.ts";

export const INBOX_ROUTES = [
  { operation: "inbox.create", method: "POST", pattern: /^\/v2\/inbox\/captures$/, path: "/v2/inbox/captures" },
  { operation: "inbox.read", method: "GET", pattern: /^\/v2\/inbox\/captures$/, path: "/v2/inbox/captures" },
  { operation: "inbox.read", method: "GET", pattern: /^\/v2\/inbox\/captures\/(cap_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/inbox/captures/<id>" },
  { operation: "inbox.command", method: "POST", pattern: /^\/v2\/inbox\/captures\/(cap_[0-9A-HJKMNP-TV-Z]{26})\/commands$/, path: "/v2/inbox/captures/<id>/commands" },
  { operation: "inbox.bindings", method: "GET", pattern: /^\/v2\/ai\/knowledge-bindings$/, path: "/v2/ai/knowledge-bindings" },
  { operation: "inbox.bindings", method: "PUT", pattern: /^\/v2\/ai\/knowledge-bindings$/, path: "/v2/ai/knowledge-bindings" },
] as const;
type InboxOperation = typeof INBOX_ROUTES[number]["operation"];

const invalid = (key = "inbox.invalid") => new HubError("INVALID", { key, args: [] });
const busy = (capture: Capture) => capture.state === "queued" || capture.state === "extracting" || capture.card === "pending";
const requestKey = (capture: string, command: CaptureCommand) =>
  `${capture}:discard:${createHash("sha256").update(JSON.stringify(command)).digest("hex")}`;

export interface InboxOptions {
  network?: CaptureNetwork;
  model?: (owner: string, profile: string) => SummaryModel;
}

export class Inbox {
  private readonly state: InboxStore;
  private readonly files: InboxFiles;
  private readonly stopping = new AbortController();
  private worker?: Promise<void>;
  private readonly indexOptions: { stateDir: string };

  constructor(private readonly config: HubConfig, private readonly hub: HubStore, private readonly ai: AIConfigurationService,
    private readonly trash: () => Trash, private readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>,
    private readonly now: () => Date, private readonly issue: (path: string, message: string) => void, private readonly options: InboxOptions = {},
    private readonly onReady?: (capture: Capture) => void) {
    this.state = new InboxStore(hub.db);
    ai.knowledgeProfileInUse = (profile, nextEngine) => this.state.profileInUse(profile, nextEngine);
    this.files = new InboxFiles(config, issue);
    this.indexOptions = { stateDir: config.stateDir };
  }

  start() {
    for (const value of this.state.interrupted()) {
      const { capture } = value;
      if (capture.state === "extracting") this.update(value, { state: "failed", error: this.error("extract_failed") });
      else this.update(value, { card: "failed", error: this.error("summary_failed") });
    }
    this.schedule();
  }

  async stop() {
    this.stopping.abort();
    await this.worker;
  }

  async handle(request: Request, operation: InboxOperation, id: string | undefined, identity: Identity): Promise<Response> {
    if (identity.actor.role !== "human") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
    const owner = identity.actor.id;
    const params = new URL(request.url).searchParams;
    const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
    if (operation === "inbox.bindings") {
      if (request.method === "GET") return respond(this.state.bindings(owner));
      const input = KnowledgeAIBindingUpdate.safeParse(await this.json(request));
      if (!input.success) throw invalid();
      return respond(await this.exclusive(async () => this.bind(owner, input.data)));
    }
    if (!this.config.vault) throw invalid("knowledge.no_vault");
    if (operation === "inbox.create") {
      const input = CaptureCreate.safeParse(await this.json(request));
      if (!input.success || containsSecret(JSON.stringify(input.data))) throw invalid();
      const result = await this.exclusive(async () => this.create(owner, input.data));
      this.schedule();
      return respond(result, result.duplicate === "none" ? 202 : 200);
    }
    if (operation === "inbox.command") {
      const input = CaptureCommand.safeParse(await this.json(request));
      if (!input.success || containsSecret(JSON.stringify(input.data))) throw invalid();
      const result = await this.exclusive(() => this.command(id!, input.data, identity));
      this.schedule();
      return respond(result);
    }
    if (id) return respond(this.state.get(id, owner).capture);
    const flags = params.get("untriaged"), limit = params.get("limit");
    const args = CaptureListArgs.safeParse({
      untriaged: flags === "true" ? true : flags === "false" ? false : flags ?? undefined,
      limit: limit === null ? undefined : /^\d+$/.test(limit) ? Number(limit) : NaN,
    });
    if (!args.success) throw invalid();
    return respond(CaptureList.parse(this.state.list(owner, args.data)));
  }

  private async json(request: Request): Promise<unknown> {
    try { return JSON.parse(await boundedText(request.body, 6 * CAPTURE_LIMITS.max_content_chars + 32_768)); }
    catch { throw invalid(); }
  }

  private create(owner: string, input: CaptureCreate): CaptureCreateResult {
    const signature = ["create", input];
    return this.hub.db.transaction(() => {
      const replay = this.state.receipt(owner, input.request_id, signature);
      if (replay) return CaptureCreateResult.parse(replay);
      let url: string | undefined;
      try { url = input.url ? normalizeCaptureUrl(input.url) : undefined; }
      catch { throw invalid("inbox.blocked"); }
      const previous = url ? this.state.byUrl(owner, url)?.capture : undefined;
      const now = this.now(), time = now.toISOString();
      const capture = previous ?? this.state.put({ input, capture: {
        id: newId("cap", now, randomBytes), owner, channel: input.channel, url,
        original_url: url !== input.url ? input.url : undefined, title: input.title,
        kind: captureKind(url), state: "queued", card: "none", attempt: 1, revision: 1, created: time, updated: time,
        triage: input.triage, triaged: input.triage ? time : undefined,
      } });
      const result = CaptureCreateResult.parse({
        capture, duplicate: previous ? previous.triage === "discard" ? "discarded" : "existing" : "none",
      });
      this.state.finish(owner, input.request_id, signature, result);
      return result;
    }).immediate();
  }

  private bind(owner: string, input: KnowledgeAIBindingUpdate) {
    const signature = ["binding", input];
    return this.hub.db.transaction(() => {
      const replay = this.state.receipt(owner, input.request_id, signature);
      if (replay) return KnowledgeAIBinding.array().parse(replay);
      if (input.profile) {
        const { profile, connection } = this.ai.get(owner, input.profile);
        const engine = input.purpose === "knowledge.summary" ? "lumio" : "embedding";
        if (profile.engine !== engine || !connection.base_url) throw invalid("ai.engine_mismatch");
      }
      const result = this.state.bind(owner, input);
      this.state.finish(owner, input.request_id, signature, result);
      return result;
    }).immediate();
  }

  private async command(id: string, input: CaptureCommand, identity: Identity): Promise<Capture> {
    const owner = identity.actor.id, signature = ["command", id, input];
    const replay = this.state.receipt(owner, input.request_id, signature);
    if (replay) return Capture.parse(replay);
    const value = this.state.get(id, owner), capture = value.capture;
    const action = input.action;
    const discard = action.op === "triage" && action.triage === "discard";
    const discardRequest = requestKey(id, input);
    if (discard && capture.triage === "discard" &&
      this.hub.db.query("SELECT 1 FROM trash_requests WHERE actor=? AND request=?").get(owner, discardRequest)) {
      this.state.finish(owner, input.request_id, signature, capture);
      return capture;
    }
    if (capture.revision !== input.expected_revision || busy(capture) || capture.triage === "discard") throw inboxConflict();
    let patch: Partial<Capture>;
    if (action.op === "retry" || action.op === "reextract") {
      if (action.op === "retry" ? capture.state !== "failed" : capture.state !== "ready") throw inboxConflict();
      if (action.op === "retry" && action.content) {
        if (value.plan) throw inboxConflict();
        value.input = { ...value.input, content: action.content };
      }
      if (action.op === "reextract" && capture.url) value.input = { ...value.input, content: undefined };
      patch = { state: "queued", error: undefined, attempt: capture.attempt + 1 };
    } else if (action.op === "triage" && !capture.entity?.id && !value.plan && capture.state === "failed") {
      patch = { triage: action.triage, triaged: this.now().toISOString() };
    } else {
      if (!capture.entity?.id || (action.op === "summarize" && capture.state !== "ready")) throw inboxConflict();
      assertNoteVisible(this.hub.db, capture.entity.id);
      const note = await noteById(this.config.vault, capture.entity.id, this.indexOptions);
      if (!note) throw inboxMissing();
      if (action.op === "summarize") {
        if (!this.state.binding(owner, "knowledge.summary")) throw invalid("inbox.summary_unconfigured");
        value.summary = action.depth;
        patch = { card: "pending", error: undefined, entity: note };
      } else if (action.triage === "discard") {
        const { revision } = await readKnowledgeDocument(this.config.vault, note.id!, this.indexOptions);
        await this.trash().deleteNoteLocked(note.id!, { request_id: discardRequest, expected_revision: revision }, identity);
        const result = this.state.get(id, owner).capture;
        this.state.finish(owner, input.request_id, signature, result);
        return result;
      } else {
        await this.files.status(note, action.triage, this.now(), owner);
        patch = { entity: note, triage: action.triage, triaged: this.now().toISOString() };
      }
    }
    return this.hub.db.transaction(() => {
      const result = this.update(value, patch);
      this.state.finish(owner, input.request_id, signature, result);
      return result;
    })();
  }

  async companions(entity: string): Promise<TrashCompanion[]> {
    const captures = this.state.byEntity(entity);
    if (captures.some(value => busy(value.capture))) throw inboxConflict();
    const result = new Map<string, TrashCompanion>();
    for (const { capture } of captures) {
      if (capture.original) result.set(capture.original, { path: capture.original, owner: entity, original: true });
      const id = capture.ai_note;
      const note = id ? await noteById(this.config.vault, id, this.indexOptions) : undefined;
      if (note?.type === "ai-note") result.set(note.path, { path: note.path, owner: id! });
    }
    return [...result.values()];
  }

  /** Called inside the trash journal's final database transaction. */
  trashed(entity: string, action: "delete-note" | "restore" | "purge", moves: readonly NoteTrashMove[], notePath?: string) {
    for (const value of this.state.byEntity(entity)) {
      if (action === "delete-note") {
        if (value.capture.triage !== "discard") value.previousTriage = value.capture.triage;
        this.update(value, { triage: "discard", triaged: this.now().toISOString() });
      } else if (action === "restore") {
        const { capture } = value;
        const original = moves.find(move => move.original && move.owner === entity)?.to ?? capture.original;
        const note = capture.entity && notePath ? { ...capture.entity, path: notePath } : capture.entity;
        const triage = value.previousTriage;
        value.previousTriage = undefined;
        this.update(value, { entity: note, original, triage, triaged: triage ? this.now().toISOString() : undefined });
      }
    }
  }

  private update(value: StoredCapture, patch: Partial<Capture>): Capture {
    const capture = { ...value.capture, ...patch, updated: this.now().toISOString(), revision: value.capture.revision + 1 };
    value.capture = this.state.put({ ...value, capture });
    return value.capture;
  }

  private error(code: CaptureError["code"]): CaptureError { return new CaptureFailure(code).description(); }

  private schedule() {
    if (this.worker || !this.config.vault || this.stopping.signal.aborted) return;
    this.worker = Promise.resolve().then(async () => {
      while (!this.stopping.signal.aborted) {
        const value = this.state.next();
        if (!value) break;
        if (value.capture.state === "queued") await this.process(value);
        else await this.summarize(value);
      }
    }).catch(() => this.issue("inbox", msg("inbox.worker_failed"))).finally(() => { this.worker = undefined; });
  }

  private async process(value: StoredCapture) {
    const capture = this.update(value, { state: "extracting" });
    try {
      const extracted = value.plan ? undefined : await extractCapture(capture.url, capture.kind!, capture.title, value.input.content,
        this.stopping.signal, this.options.network);
      await this.exclusive(async () => {
        if (!value.plan) {
          const now = this.now();
          const entityId = newId(extracted!.note.kind === "paper" ? "pap" : "src", now, randomBytes);
          value.plan = await this.files.prepare(capture, extracted!, entityId, now);
          this.state.put(value);
        }
        const plan = value.plan;
        await this.files.publish(capture, plan);
        const configured = !!this.state.binding(capture.owner, "knowledge.summary");
        value.ownsEntity ??= plan.entityBytes !== undefined;
        value.plan = undefined;
        value.summary = "card";
        this.hub.db.transaction(() => {
          const ready = this.update(value, {
            state: "ready", entity: plan.entity, title: plan.entity.title, original: plan.original, error: undefined,
            card: configured ? "pending" : capture.ai_note ? capture.card : "none",
          });
          this.hub.audit(this.hub.recoveryIdentity(capture.owner), "inbox.extract", "allow", undefined, `ready:${capture.id}`);
          this.onReady?.(ready);
        })();
      });
    } catch (cause) {
      const error = cause instanceof CaptureFailure ? cause.description() : this.error("extract_failed");
      this.update(value, { state: "failed", error });
      this.hub.audit(this.hub.recoveryIdentity(capture.owner), "inbox.extract", "allow", undefined, error.code);
    }
  }

  private async summarize(value: StoredCapture) {
    const { capture } = value, owner = capture.owner;
    const actor: Identity = { actor: this.hub.inboxActor(), label: "inbox-summary" };
    try {
      const binding = this.state.binding(owner, "knowledge.summary");
      if (!binding) { this.update(value, { card: capture.ai_note ? "ready" : "none", error: undefined }); return; }
      const id = value.cardId ??= newId("ain", this.now(), randomBytes);
      this.state.put(value);
      if (!capture.entity?.id) throw inboxMissing();
      assertNoteVisible(this.hub.db, capture.entity.id);
      assertNoteVisible(this.hub.db, id);
      const original = await showOriginal(this.config.vault, capture.entity.id, this.indexOptions);
      if (containsSecret(original.body)) throw new CaptureFailure("summary_failed");
      const existing = await noteById(this.config.vault, id, this.indexOptions);
      const revision = existing ? (await readKnowledgeDocument(this.config.vault, id, this.indexOptions)).revision : undefined;
      if (!revision && capture.ai_note) throw inboxMissing();
      const provider = this.options.model ? this.options.model(owner, binding.profile) : this.ai.model(owner, binding.profile);
      const input = await summarizeOriginal(this.config, capture, original.body, value.summary ?? "card", provider, this.stopping.signal);
      await this.exclusive(async () => {
        const current = this.state.binding(owner, "knowledge.summary");
        if (current?.profile !== binding.profile || current.revision !== binding.revision) throw inboxConflict();
        assertNoteVisible(this.hub.db, capture.entity!.id!);
        assertNoteVisible(this.hub.db, id);
        const now = this.now();
        const note = await this.files.card(id, input, actor.actor.id, now, revision);
        if (value.ownsEntity && !capture.ai_note) await this.files.embed(original.note, note, owner, now);
        this.update(value, { ai_note: id, card: value.summary === "deep" ? "deep" : "ready", error: undefined });
        this.hub.audit(actor, revision ? "knowledge.ainote.update" : "knowledge.ainote.create", "allow", undefined, `applied:${id}`);
      });
    } catch {
      this.update(value, { card: "failed", error: this.error("summary_failed") });
      this.hub.audit(actor, "inbox.summary", "allow", undefined, "summary_failed");
    }
  }
}
