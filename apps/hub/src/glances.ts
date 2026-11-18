import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newId } from "@lumio/foundation";
import { GLANCE_LIMITS, Glance, GlanceCreate, GlanceContextRetention, GlanceDeleteResult, ResourceRef, type Actor } from "@lumio/schema";
import { StorageError, type SqliteArtifacts } from "@lumio/storage";
import { localHubUrl, type HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { checkGlanceImage, withPointer } from "./glance-image.ts";
import { pointGlance, readingOrder } from "./glance-pointing.ts";
import { extractPageContent } from "./inbox-extract.ts";
import type { HubStore, Identity } from "./store.ts";
import { assertNoteVisible } from "./trash.ts";

export const GLANCE_ROUTES = [
  { operation: "glance.create", method: "POST", pattern: /^\/v2\/glances$/, path: "/v2/glances" },
  { operation: "glance.read", method: "GET", pattern: /^\/v2\/glances\/(gln_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/glances/<id>" },
  { operation: "glance.read", method: "GET", pattern: /^\/v2\/glances\/(gln_[0-9A-HJKMNP-TV-Z]{26})\/image$/, path: "/v2/glances/<id>/image" },
  { operation: "glance.delete", method: "DELETE", pattern: /^\/v2\/glances\/(gln_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/glances/<id>" },
] as const;

const invalid = (key = "glance.invalid") => new HubError("INVALID", { key, args: [] });
const notFound = () => new HubError("NOT_FOUND", { key: "glance.not_found", args: [] });
const conflict = () => new HubError("CONFLICT", { key: "glance.conflict", args: [] });
const forbidden = () => new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const noStore = { "Cache-Control": "no-store" };
const maxMetaBytes = 1024 * 1024;
const maxMultipartBytes = GLANCE_LIMITS.max_image_bytes + GLANCE_LIMITS.max_page_bytes + maxMetaBytes;
const cleanupInterval = 60_000;

interface GlanceRow { record: string; fingerprint: string }

async function multipart(request: Request): ReturnType<Response["formData"]> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data;") || !request.body ||
    Number(request.headers.get("content-length") ?? 0) > maxMultipartBytes) throw invalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxMultipartBytes) throw invalid();
      chunks.push(value);
    }
    return await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData();
  } catch { throw invalid(); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function windowText(glance: Glance): string {
  return readingOrder(glance.ocr).map(index => glance.ocr[index]!.text).join("\n");
}

export class Glances {
  private timer?: ReturnType<typeof setInterval>;
  private cleaning?: Promise<void>;
  constructor(private readonly config: HubConfig, private readonly store: HubStore, private readonly files: SqliteArtifacts,
    private readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>, private readonly port: () => number,
    private readonly now: () => Date) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS hub_glances (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES actors(id), request TEXT NOT NULL, fingerprint TEXT NOT NULL,
      record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(owner,request));
      CREATE INDEX IF NOT EXISTS glances_expiry ON hub_glances(json_extract(record,'$.created'))
      WHERE json_extract(record,'$.image.file') IS NOT NULL AND json_extract(record,'$.image.purged') IS NULL
        AND json_extract(record,'$.used_by.capture') IS NULL;`);
  }

  start(recover?: () => Promise<void>): void {
    const scan = () => {
      if (!this.cleaning) this.cleaning = (async () => { await recover?.(); await this.exclusive(() => this.sweep()); })().catch(() => {}).finally(() => { this.cleaning = undefined; });
    };
    scan();
    this.timer = setInterval(scan, cleanupInterval);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.cleaning;
  }

  get(id: string, owner: string): Glance {
    const row = this.store.db.query<GlanceRow, [string, string]>("SELECT record,fingerprint FROM hub_glances WHERE id=? AND owner=?").get(id, owner);
    if (!row) throw notFound();
    return Glance.parse(JSON.parse(row.record));
  }

  private save(glance: Glance): Glance {
    const result = Glance.parse(glance);
    this.store.db.query("UPDATE hub_glances SET record=? WHERE id=?").run(JSON.stringify(result), result.id);
    return result;
  }

  /** Used within the same database transaction as the capture or user message. */
  claim(id: string, owner: string, kind: "capture" | "message", ref: string): Glance {
    const glance = this.get(id, owner);
    const previous = glance.used_by[kind];
    if (previous && previous !== ref) throw conflict();
    return previous ? glance : this.save({ ...glance, used_by: { ...glance.used_by, [kind]: ref },
      ...(kind === "message" ? { context_retention: { status: "pending" as const, text: [], image: false, source: false } } : {}) });
  }

  pendingContexts(): { id: string; owner: string; message: string }[] {
    return this.store.db.query<{ id: string; owner: string; message: string }, []>(`
      SELECT id, owner, json_extract(record,'$.used_by.message') AS message FROM hub_glances
      WHERE json_extract(record,'$.context_retention.status')='pending'
        OR json_extract(record,'$.context_retention.enrichment_pending')=1 LIMIT 32
    `).all();
  }

  async retainContext(id: string, owner: string, message: string, decision?: GlanceContextRetention): Promise<Glance> {
    return this.exclusive(async () => {
      const original = this.get(id, owner);
      if (original.used_by.message !== message) throw conflict();
      if (original.context_retention?.status !== "pending") return original;
      const requested = decision ?? { text: original.context_retention.text, image: original.context_retention.image, source: original.context_retention.source };
      const parsed = GlanceContextRetention.safeParse(requested);
      const wanted = parsed.success ? parsed.data : { text: [], image: false, source: false };
      // A recovered, already filtered pending record contains only verified excerpts.
      const page = await this.pageText(original);
      const originals = [original.selection_text, original.pointing.text, windowText(original), page, ...(original.context_retention?.text ?? [])].filter((value): value is string => !!value);
      const retained = [...new Set(wanted.text.filter(value => originals.some(source => source.includes(value))))];
      const keepImage = wanted.image && !!original.image && !original.image.purged;
      const source = wanted.source;
      if (original.used_by.capture) {
        return this.save({ ...original, context_retention: { status: "retained", text: retained, image: !!original.image && !original.image.purged, source: true, enrichment_pending: true, finalized: this.now().toISOString() } });
      }
      const minimized = this.store.db.transaction(() => {
        let next = this.save({ ...original,
          app: source ? original.app : { name: "Screen" }, window_title: source ? original.window_title : undefined,
          url: source ? original.url : undefined, lumio: source ? original.lumio : undefined,
          selection_text: undefined, ocr: [], ocr_engine: undefined, pointing: { method: "none", blocks: [] },
          pointer: keepImage ? original.pointer : undefined, trail: [],
          context_retention: { status: "pending", text: retained, image: keepImage, source },
        });
        if (!keepImage) { this.removeImage(next); next = this.get(id, owner); }
        next = this.removePage(next);
        return this.save({ ...next, context_retention: { status: retained.length || keepImage || source ? "retained" : "discarded",
          text: retained, image: keepImage, source, enrichment_pending: true, finalized: this.now().toISOString() } });
      })();
      // The removal queue survives a crash between the metadata update and unlink.
      await this.files.sweepCaptureFiles();
      return minimized;
    });
  }

  completeContext(id: string, owner: string, message: string): void {
    const glance = this.get(id, owner);
    if (glance.used_by.message !== message) throw conflict();
    if (glance.context_retention) this.save({ ...glance, context_retention: { ...glance.context_retention, enrichment_pending: false } });
  }

  isHubURL(url: string | undefined): boolean {
    if (!url) return false;
    const origin = new URL(url).origin;
    return [localHubUrl(this.config.hostname, this.port()), this.config.publicUrl, ...this.config.webOrigins]
      .some(value => value && new URL(value).origin === origin);
  }

  private reference(url: string): ResourceRef | undefined {
    const shared = new URL(url);
    if (shared.pathname !== "/" && shared.pathname !== new URL(this.config.publicUrl ?? shared.origin).pathname) return;
    const [section, value] = shared.hash.slice(1).split("/");
    if (!value) return;
    const match = ResourceRef.safeParse({ module: section, id: value });
    return match.data;
  }

  async handle(request: Request, identity: Identity, id?: string): Promise<Response> {
    if (identity.actor.role !== "human") throw forbidden();
    const owner = identity.actor.id;
    if (request.method === "POST") {
      const form = await multipart(request);
      const meta = form.get("meta"), part = form.get("image"), page = form.get("page");
      if (form.getAll("meta").length !== 1 || form.getAll("image").length > 1 || form.getAll("page").length > 1 ||
        [...form.keys()].some(key => !["meta", "image", "page"].includes(key))) throw invalid();
      if (typeof meta !== "string" && !(meta instanceof File)) throw invalid();
      if ((typeof meta === "string" ? Buffer.byteLength(meta) : meta.size) > maxMetaBytes) throw invalid();
      const raw = typeof meta === "string" ? meta : await meta.text();
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw invalid(); }
      const parsed = GlanceCreate.safeParse(value);
      if (!parsed.success || (!!parsed.data.image !== !!part) || (part !== null && !(part instanceof File)) ||
        (!!parsed.data.page !== !!page) || (page !== null && (!(page instanceof File) || page.size > GLANCE_LIMITS.max_page_bytes))) throw invalid();
      const bytes = part ? Buffer.from(await part.arrayBuffer()) : undefined;
      if (bytes && !checkGlanceImage(bytes, parsed.data.image!)) throw invalid("glance.invalid_image");
      let pageBody: { text: string; hash: string } | undefined;
      if (page) {
        const rawPage = Buffer.from(await page.arrayBuffer());
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(rawPage); } catch { throw invalid(); }
        if (!text.trim() || text.length > GLANCE_LIMITS.max_page_chars) throw invalid();
        pageBody = { text, hash: digest(rawPage) };
      }
      const glance = await this.exclusive(() => this.create(owner, parsed.data, bytes, pageBody));
      this.store.audit(identity, "glance.create", "allow", undefined, "applied");
      return Response.json(glance, { headers: noStore });
    }
    if (request.method === "DELETE") {
      const result = await this.exclusive(async () => {
        const glance = this.get(id!, owner);
        if (glance.used_by.capture || glance.used_by.message) throw conflict();
        this.store.db.transaction(() => {
          if (glance.image && !glance.image.purged) this.files.removeCaptureFile(glance.image.file);
          this.removePage(glance);
          this.store.db.query("DELETE FROM hub_glances WHERE id=?").run(glance.id);
        })();
        await this.files.sweepCaptureFiles().catch(() => {});
        return GlanceDeleteResult.parse({ id, deleted: true });
      });
      this.store.audit(identity, "glance.delete", "allow", undefined, "applied");
      return Response.json(result, { headers: noStore });
    }
    const glance = this.get(id!, owner);
    if (!new URL(request.url).pathname.endsWith("/image")) return Response.json(glance, { headers: noStore });
    try {
      const file = await this.image(glance);
      return new Response(Bun.file(file), { headers: { ...noStore, "Content-Type": `image/${glance.image!.format}`, "X-Content-Type-Options": "nosniff" } });
    } catch (cause) {
      if (cause instanceof StorageError && ["NOT_FOUND", "CONFLICT"].includes(cause.code)) throw notFound();
      throw cause;
    }
  }

  private async create(owner: string, input: GlanceCreate, bytes?: Buffer, pageBody?: { text: string; hash: string }): Promise<Glance> {
    const { request_id, image, page, ...fields } = input;
    const sha = bytes && digest(bytes);
    const fingerprint = digest(JSON.stringify(pageBody ? [input, sha, pageBody.hash] : [input, sha]));
    const prior = this.store.db.query<GlanceRow, [string, string]>("SELECT record,fingerprint FROM hub_glances WHERE owner=? AND request=?").get(owner, request_id);
    if (prior && prior.fingerprint !== fingerprint) throw conflict();
    const inner = this.isHubURL(fields.url);
    const document = page && pageBody && !inner ? this.preparePage(page, pageBody.text, fields.url!) : undefined;
    const now = this.now();
    const glance = prior ? Glance.parse(JSON.parse(prior.record)) : this.store.db.transaction(() => {
      const id = newId("gln", now, randomBytes), created = now.toISOString();
      let stored: Glance["image"];
      if (image && bytes && sha && !inner) {
        const file = newId("art", now, randomBytes);
        stored = { ...image, file, bytes: bytes.length, sha256: sha };
        this.files.stage({ id: file, key: `${file}.bin`, owner: { module: "hub", id }, sha256: sha,
          size: bytes.length, media_type: `image/${image.format}`, status: "staged", private: true, created });
      }
      const result = Glance.parse({
        ...fields, id, owner, created, image: stored, used_by: {},
        page: document && (() => {
          const file = newId("art", now, randomBytes);
          this.files.stage({ id: file, key: `${file}.bin`, owner: { module: "hub", id }, sha256: document.sha256,
            size: document.bytes, media_type: "text/markdown; charset=utf-8", status: "staged", private: true, created });
          const { body: _, ...metadata } = document;
          return { ...metadata, file };
        })(),
        ...(inner ? { pointing: { method: "none" }, lumio: this.reference(fields.url!), pointer: undefined, trail: [],
          selection_text: undefined, ocr: [], ocr_engine: undefined } : { pointing: pointGlance(input) }),
      });
      this.store.db.query("INSERT INTO hub_glances VALUES(?,?,?,?,?)").run(id, owner, request_id, fingerprint, JSON.stringify(result));
      return result;
    })();
    if (glance.image && !glance.image.purged && bytes && this.files.get(glance.image.file).status === "staged") {
      await this.files.publish(glance.image.file, (async function* () { yield bytes; })());
    }
    if (glance.page && !glance.page.purged && this.files.get(glance.page.file).status === "staged") {
      if (!document || document.sha256 !== glance.page.sha256) throw conflict();
      await this.files.publish(glance.page.file, (async function* () { yield Buffer.from(document.body); })());
    }
    return glance;
  }

  private preparePage(page: NonNullable<GlanceCreate["page"]>, text: string, url: string) {
    try {
      const result = extractPageContent({ format: page.format, body: text }, url);
      const bytes = Buffer.byteLength(result.body);
      if (!bytes || bytes > GLANCE_LIMITS.max_page_bytes || result.body.length > GLANCE_LIMITS.max_page_chars) return;
      const title = (page.title ?? result.title)?.trim().slice(0, 500).replace(/[\uD800-\uDBFF]$/, "");
      return { ...result, title: title || undefined, format: page.format, bytes, sha256: digest(result.body) };
    } catch { /* The existing screen capture remains usable when HTML extraction fails. */ }
  }

  async pageText(glance: Glance): Promise<string | undefined> {
    const page = glance.page;
    if (!page || page.purged) return;
    try {
      const artifact = this.files.get(page.file);
      if (artifact.owner.module !== "hub" || artifact.owner.id !== glance.id) return;
      const bytes = await readFile(await this.files.path(page.file));
      if (bytes.length === page.bytes && digest(bytes) === page.sha256) return bytes.toString("utf8");
    } catch (cause) {
      if (!(cause instanceof StorageError) || !["NOT_FOUND", "CONFLICT"].includes(cause.code)) throw cause;
    }
  }

  private image(glance: Glance): Promise<string> {
    if (!glance.image || glance.image.purged) throw notFound();
    const artifact = this.files.get(glance.image.file);
    if (artifact.owner.module === "knowledge") assertNoteVisible(this.store.db, artifact.owner.id);
    else if (artifact.owner.module !== "hub" || artifact.owner.id !== glance.id) throw notFound();
    return this.files.path(artifact.id);
  }

  async markedImage(glance: Glance, signal?: AbortSignal) {
    const image = await readFile(await this.image(glance), { signal });
    if (digest(image) !== glance.image?.sha256) throw invalid("glance.invalid_image");
    return withPointer(image, glance.image!, glance.pointer);
  }

  /** A successfully persisted capture is the ownership proof for the newly published entity. */
  transfer(glanceId: string, capture: string, entity: string, owner: Actor, ownsEntity: () => boolean): void {
    const glance = this.get(glanceId, owner.id);
    if (glance.used_by.capture !== capture || !ownsEntity()) throw conflict();
    this.removePage(glance);
    if (!glance.image || glance.image.purged) return;
    this.files.transferToKnowledge(glance.image.file, { module: "hub", id: glanceId }, { module: "knowledge", id: entity },
      ref => (ref.module === "hub" ? glance.used_by.capture === capture : ownsEntity()) ? owner : undefined);
  }

  purgeKnowledge(entity: string): void {
    for (const file of this.files.list({ module: "knowledge", id: entity })) {
      const row = this.store.db.query<GlanceRow, [string]>("SELECT record,fingerprint FROM hub_glances WHERE json_extract(record,'$.image.file')=?").get(file.id);
      if (!row) continue;
      this.removeImage(Glance.parse(JSON.parse(row.record)));
    }
  }

  private removeImage(glance: Glance): void {
    if (!glance.image || glance.image.purged) return;
    try { this.files.removeCaptureFile(glance.image.file); }
    catch (cause) { if (!(cause instanceof StorageError) || cause.code !== "NOT_FOUND") throw cause; }
    this.save({ ...glance, image: { ...glance.image, purged: this.now().toISOString() } });
  }

  private removePage(glance: Glance): Glance {
    if (!glance.page || glance.page.purged) return glance;
    try { this.files.removeCaptureFile(glance.page.file); }
    catch (cause) { if (!(cause instanceof StorageError) || cause.code !== "NOT_FOUND") throw cause; }
    return this.save({ ...glance, page: { ...glance.page, title: undefined, purged: this.now().toISOString() } });
  }

  async sweep(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.config.glanceRetentionDays * 86_400_000).toISOString();
    this.store.db.transaction(() => {
      const rows = this.store.db.query<GlanceRow, [string]>(`SELECT record,fingerprint FROM hub_glances
        WHERE json_extract(record,'$.image.file') IS NOT NULL AND json_extract(record,'$.image.purged') IS NULL
          AND json_extract(record,'$.used_by.capture') IS NULL AND json_extract(record,'$.created') <= ?`).all(cutoff);
      for (const row of rows) this.removeImage(Glance.parse(JSON.parse(row.record)));
      const pages = this.store.db.query<GlanceRow, [string]>(`SELECT record,fingerprint FROM hub_glances
        WHERE json_extract(record,'$.page.file') IS NOT NULL AND json_extract(record,'$.page.purged') IS NULL
          AND json_extract(record,'$.created') <= ?`).all(cutoff);
      for (const row of pages) this.removePage(Glance.parse(JSON.parse(row.record)));
    })();
    await this.files.sweepCaptureFiles();
  }
}
