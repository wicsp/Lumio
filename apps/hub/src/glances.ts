import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newId } from "@lumio/foundation";
import { GLANCE_LIMITS, Glance, GlanceCreate, GlanceDeleteResult, ResourceRef, type Actor } from "@lumio/schema";
import { StorageError, type SqliteArtifacts } from "@lumio/storage";
import { localHubUrl, type HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { checkGlanceImage, withPointer } from "./glance-image.ts";
import { pointGlance, readingOrder } from "./glance-pointing.ts";
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
const maxMultipartBytes = GLANCE_LIMITS.max_image_bytes + 1024 * 1024;
const cleanupInterval = 60 * 60_000;

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

  start(): void {
    const scan = () => {
      if (!this.cleaning) this.cleaning = this.exclusive(() => this.sweep()).catch(() => {}).finally(() => { this.cleaning = undefined; });
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
    return previous ? glance : this.save({ ...glance, used_by: { ...glance.used_by, [kind]: ref } });
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
      const meta = form.get("meta"), part = form.get("image");
      if (form.getAll("meta").length !== 1 || form.getAll("image").length > 1 || [...form.keys()].some(key => key !== "meta" && key !== "image")) throw invalid();
      if (typeof meta !== "string" && !(meta instanceof File)) throw invalid();
      const raw = typeof meta === "string" ? meta : await meta.text();
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw invalid(); }
      const parsed = GlanceCreate.safeParse(value);
      if (!parsed.success || (!!parsed.data.image !== !!part) || (part !== null && !(part instanceof File))) throw invalid();
      const bytes = part ? Buffer.from(await part.arrayBuffer()) : undefined;
      if (bytes && !checkGlanceImage(bytes, parsed.data.image!)) throw invalid("glance.invalid_image");
      const glance = await this.exclusive(() => this.create(owner, parsed.data, bytes));
      this.store.audit(identity, "glance.create", "allow", undefined, "applied");
      return Response.json(glance, { headers: noStore });
    }
    if (request.method === "DELETE") {
      const result = await this.exclusive(async () => {
        const glance = this.get(id!, owner);
        if (glance.used_by.capture || glance.used_by.message) throw conflict();
        this.store.db.transaction(() => {
          if (glance.image && !glance.image.purged) this.files.removeCaptureFile(glance.image.file);
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

  private async create(owner: string, input: GlanceCreate, bytes?: Buffer): Promise<Glance> {
    const { request_id, image, ...fields } = input;
    const sha = bytes && digest(bytes);
    const fingerprint = digest(JSON.stringify([input, sha]));
    const prior = this.store.db.query<GlanceRow, [string, string]>("SELECT record,fingerprint FROM hub_glances WHERE owner=? AND request=?").get(owner, request_id);
    if (prior && prior.fingerprint !== fingerprint) throw conflict();
    const inner = this.isHubURL(fields.url);
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
        ...(inner ? { pointing: { method: "none" }, lumio: this.reference(fields.url!), pointer: undefined, trail: [],
          selection_text: undefined, ocr: [], ocr_engine: undefined } : { pointing: pointGlance(input) }),
      });
      this.store.db.query("INSERT INTO hub_glances VALUES(?,?,?,?,?)").run(id, owner, request_id, fingerprint, JSON.stringify(result));
      return result;
    })();
    if (glance.image && !glance.image.purged && bytes && this.files.get(glance.image.file).status === "staged") {
      await this.files.publish(glance.image.file, (async function* () { yield bytes; })());
    }
    return glance;
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
    this.files.removeCaptureFile(glance.image.file);
    this.save({ ...glance, image: { ...glance.image, purged: this.now().toISOString() } });
  }

  async sweep(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.config.glanceRetentionDays * 86_400_000).toISOString();
    this.store.db.transaction(() => {
      const rows = this.store.db.query<GlanceRow, [string]>(`SELECT record,fingerprint FROM hub_glances
        WHERE json_extract(record,'$.image.file') IS NOT NULL AND json_extract(record,'$.image.purged') IS NULL
          AND json_extract(record,'$.used_by.capture') IS NULL AND json_extract(record,'$.created') <= ?`).all(cutoff);
      for (const row of rows) this.removeImage(Glance.parse(JSON.parse(row.record)));
    })();
    await this.files.sweepCaptureFiles();
  }
}
