import { S3Client } from "bun";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";
import { randomUUID } from "node:crypto";
import { readKnowledgeDocument } from "@lumio/storage";
import { Id, IMAGE_UPLOAD_MAX_BYTES, ImageHostingRecord, ImageHostingSettings, ImageHostingUpdate, ImageUploadResult, type ImageHostingDestination } from "@lumio/schema";
import type { HubConfig } from "./config.ts";
import { WriteCoordinator } from "./coordinator.ts";
import { HubError } from "./errors.ts";
import { isPublicAddress, validateCaptureUrl } from "./inbox-fetch.ts";
import { atomicFile, optional } from "./setup.ts";
import type { HubStore } from "./store.ts";
import { assertNoteVisible } from "./trash.ts";

export const IMAGE_HOSTING_ROUTES = [
  { operation: "knowledge.image-settings", method: "GET", pattern: /^\/v2\/knowledge\/image-hosting$/, path: "/v2/knowledge/image-hosting" },
  { operation: "knowledge.image-settings", method: "PUT", pattern: /^\/v2\/knowledge\/image-hosting$/, path: "/v2/knowledge/image-hosting" },
  { operation: "knowledge.image-upload", method: "POST", pattern: /^\/v2\/knowledge\/notes\/([^/]+)\/images$/, path: "/v2/knowledge/notes/<id>/images" },
] as const;

const error = (key: string, code: "INVALID" | "INTERNAL" | "CONFLICT" = "INVALID") => new HubError(code, { key, args: [] });
const noStore = { "Cache-Control": "no-store" };
const upstreamLimit = 128 * 1024;
const settingsLimit = 128 * 1024;
const multipartLimit = IMAGE_UPLOAD_MAX_BYTES + 64 * 1024;
const reservedHeaders = /^(?:host|content-length|content-type|transfer-encoding|connection|upgrade|expect|cookie|proxy-.*|te|trailer|keep-alive)$/i;
type Destination = ImageHostingDestination;
type Credentials = ImageHostingRecord["credentials"];
type Upload = Pick<ImageUploadResult, "media_type"> & { bytes: Buffer };
type Upstream = { method: string; headers: Headers; body: Buffer };
export type ImageHostingSend = (url: URL, input: Upstream, signal: AbortSignal) => Promise<Buffer>;

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, key: string): Promise<Buffer> {
  if (!body) throw error(key);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const data = await reader.read();
      if (data.done) return Buffer.concat(chunks, size);
      size += data.value.byteLength;
      if (size > limit) throw error(key);
      chunks.push(data.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function imageType(bytes: Buffer): ImageUploadResult["media_type"] | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 16).startsWith("WEBPVP8")) return "image/webp";
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const end = Math.min(bytes.length, bytes.readUInt32BE(0), 256);
    for (let offset = 8; offset + 4 <= end; offset += offset === 8 ? 8 : 4) {
      if (["avif", "avis"].includes(bytes.toString("ascii", offset, offset + 4))) return "image/avif";
    }
  }
}

async function uploadedImage(request: Request): Promise<Upload> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type) || Number(request.headers.get("content-length")) > multipartLimit) throw error("image-hosting.upload-invalid");
  const body = await readBounded(request.body, multipartLimit, "image-hosting.upload-invalid");
  let form: Awaited<ReturnType<Response["formData"]>>;
  try { form = await new Response(new Uint8Array(body), { headers: { "Content-Type": type } }).formData(); }
  catch { throw error("image-hosting.upload-invalid"); }
  const image = form.get("image");
  if ([...form.keys()].length !== 1 || !(image instanceof File) || !image.size || image.size > IMAGE_UPLOAD_MAX_BYTES) throw error("image-hosting.upload-invalid");
  const bytes = Buffer.from(await image.arrayBuffer());
  const media_type = imageType(bytes);
  if (!media_type) throw error("image-hosting.upload-invalid");
  return { bytes, media_type };
}

function safeUpstream(url: URL, privateOrigins: ReadonlySet<string>): string {
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw error("image-hosting.upstream");
  return privateOrigins.has(url.origin) ? url.hostname.replace(/^\[|\]$/g, "") : validateCaptureUrl(url);
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function pinnedSend(privateOrigins: ReadonlySet<string>): ImageHostingSend {
  return async (url, input, signal) => {
    signal.throwIfAborted();
    const hostname = safeUpstream(url, privateOrigins);
    const addresses = isIP(hostname) ? [hostname] : (await abortable(lookup(hostname, { all: true }), signal)).map(item => item.address);
    if (!addresses.length || (!privateOrigins.has(url.origin) && addresses.some(address => !isPublicAddress(address)))) throw error("image-hosting.upstream");
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        hostname: addresses.find(address => isIP(address) === 4) ?? addresses[0],
        port: url.port || 443,
        servername: isIP(hostname) ? undefined : hostname,
        checkServerIdentity: (_server, cert) => checkServerIdentity(hostname, cert),
        method: input.method, path: url.pathname + url.search, signal, agent: false,
        headers: { ...Object.fromEntries(input.headers), Host: url.host, "Content-Length": input.body.byteLength, "Accept-Encoding": "identity" },
      }, response => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          reject(error("image-hosting.upstream"));
          return;
        }
        if (Number(response.headers["content-length"]) > upstreamLimit) {
          response.destroy();
          reject(error("image-hosting.upstream"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > upstreamLimit) {
            response.destroy();
            reject(error("image-hosting.upstream"));
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve(Buffer.concat(chunks, size)));
      });
      request.once("error", reject);
      request.end(input.body);
    });
  };
}

const encodedKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");
const keyUrl = (base: string, key: string) => new URL(base.replace(/\/+$/, "") + "/" + encodedKey(key));
function formatKey(prefix: string, type: Upload["media_type"]): string {
  const directory = prefix.split("/").filter(Boolean).join("/");
  const ext = type === "image/jpeg" ? "jpg" : type.slice(6);
  return [directory, randomUUID() + "." + ext].filter(Boolean).join("/");
}

function readPath(body: Buffer, path: NonNullable<Extract<Destination, { kind: "http" }>["response_path"]>): string {
  let value: unknown = JSON.parse(body.toString("utf8"));
  for (const field of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, field)) throw error("image-hosting.bad-url");
    value = (value as Record<string | number, unknown>)[field];
  }
  if (typeof value !== "string" || !value || value.startsWith("//") || /[\s\\]/.test(value)) throw error("image-hosting.bad-url");
  return value;
}

function scope(value: Destination | null): string {
  if (value?.kind === "s3") return JSON.stringify([value.kind, value.endpoint, value.region, value.bucket, value.virtual_hosted]);
  if (value?.kind === "http") return JSON.stringify([value.kind, value.endpoint]);
  if (value?.kind === "github") return JSON.stringify([value.kind, value.repository]);
  return "";
}

async function deliver(destination: Destination, credentials: Credentials, image: Upload, key: string, send: ImageHostingSend, signal: AbortSignal): Promise<URL> {
  const delivery = keyUrl(destination.public_base, key);
  if (destination.kind === "s3" && credentials?.kind === "s3") {
    const client = new S3Client({
      accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key,
      bucket: destination.bucket, region: destination.region, virtualHostedStyle: destination.virtual_hosted,
      ...(destination.endpoint ? { endpoint: destination.endpoint } : {}),
    });
    const url = new URL(client.presign(key, { method: "PUT", expiresIn: 60 }));
    await send(url, { method: "PUT", headers: new Headers({ "Content-Type": image.media_type }), body: image.bytes }, signal);
    return delivery;
  }
  if (destination.kind === "github" && credentials?.kind === "github") {
    const url = keyUrl("https://api.github.com/repos/" + destination.repository + "/contents", key);
    const headers = new Headers({ Authorization: "Bearer " + credentials.token, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "Lumio", "X-GitHub-Api-Version": "2022-11-28" });
    await send(url, { method: "PUT", headers, body: Buffer.from(JSON.stringify({
      branch: destination.branch, message: "Add note image", content: image.bytes.toString("base64"),
    })) }, signal);
    return delivery;
  }
  if (destination.kind !== "http") throw error("image-hosting.missing-credentials");
  const options = credentials?.kind === "http" ? credentials : undefined;
  const url = new URL(destination.endpoint.replaceAll("{key}", () => encodedKey(key)));
  for (const [field, value] of Object.entries(options?.query ?? {})) url.searchParams.set(field, value);
  const headers = new Headers(options?.headers);
  let body = image.bytes;
  if (destination.file_field) {
    const form = new FormData();
    for (const [field, value] of Object.entries(options?.fields ?? {})) form.set(field, value);
    form.set(destination.file_field, new Blob([new Uint8Array(image.bytes)], { type: image.media_type }), key.split("/").at(-1));
    const response = new Response(form);
    headers.set("Content-Type", response.headers.get("content-type")!);
    body = Buffer.from(await response.arrayBuffer());
  } else headers.set("Content-Type", image.media_type);
  const response = await send(url, { method: destination.method, headers, body }, signal);
  return destination.response_path ? new URL(readPath(response, destination.response_path), destination.public_base.replace(/\/+$/, "") + "/") : delivery;
}

export class ImageHosting {
  private readonly writes = new WriteCoordinator();
  private readonly closing = new AbortController();
  private readonly send: ImageHostingSend;
  private readonly privateOrigins: ReadonlySet<string>;

  private constructor(private readonly config: HubConfig, private readonly store: HubStore, private readonly path: string,
    private record: ImageHostingRecord, send?: ImageHostingSend) {
    this.privateOrigins = new Set((process.env.LUMIO_IMAGE_HOSTING_PRIVATE_ORIGINS ?? "").split(",").flatMap(value => {
      try {
        const url = new URL(value.trim());
        return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? [url.origin] : [];
      } catch { return []; }
    }));
    this.send = send ?? pinnedSend(this.privateOrigins);
  }

  static async open(config: HubConfig, store: HubStore, send?: ImageHostingSend): Promise<ImageHosting> {
    const path = join(config.stateDir, "image-hosting.json");
    try {
      const file = await optional(path);
      return new ImageHosting(config, store, path, file === undefined
        ? { revision: 1, destination: null, credentials: null, preview_origins: [] }
        : ImageHostingRecord.parse(JSON.parse(file)), send);
    } catch { throw error("image-hosting.settings-read", "INTERNAL"); }
  }

  previewOrigins(): string[] { return this.record.preview_origins; }

  private view(): ImageHostingSettings {
    const { revision, preview_origins, destination, credentials } = this.record;
    return ImageHostingSettings.parse({ revision, preview_origins, destination, credentials_saved: credentials !== null });
  }

  private update(input: ImageHostingUpdate): Promise<ImageHostingSettings> {
    return this.writes.exclusive(async () => {
      if (input.expected_revision !== this.record.revision) throw error("image-hosting.conflict", "CONFLICT");
      const { destination } = input;
      const preview_origins = [...new Set(input.preview_origins.map(value => new URL(value).origin))];
      const credentials = !destination ? null : input.credentials !== undefined ? input.credentials
        : scope(this.record.destination) === scope(destination) ? this.record.credentials : null;
      if ((credentials && credentials.kind !== destination?.kind)
        || (destination && destination.kind !== "http" && !credentials)) throw error("image-hosting.missing-credentials");
      if (destination && !preview_origins.includes(new URL(destination.public_base).origin)) throw error("image-hosting.bad-url");
      if (destination?.kind === "http" && (Object.keys(credentials?.kind === "http" ? credentials.headers ?? {} : {}).some(key => reservedHeaders.test(key))
          || (!destination.response_path && !destination.endpoint.includes("{key}")))) throw error("image-hosting.settings-invalid");
      if (destination && "endpoint" in destination && destination.endpoint) {
        try { safeUpstream(new URL(destination.endpoint.replaceAll("{key}", "image.png")), this.privateOrigins); }
        catch { throw error("image-hosting.settings-invalid"); }
      }
      if (credentials?.kind === "http") {
        try { new Headers(credentials.headers); }
        catch { throw error("image-hosting.settings-invalid"); }
      }
      const next = ImageHostingRecord.parse({ revision: input.expected_revision + 1, preview_origins, destination, credentials });
      try { await atomicFile(this.path, JSON.stringify(next) + "\n", 0o600); }
      catch { throw error("image-hosting.settings-write", "INTERNAL"); }
      this.record = next;
      return this.view();
    });
  }

  async handle(request: Request, id: string | undefined): Promise<Response> {
    if (request.method === "GET") return Response.json(this.view(), { headers: noStore });
    if (request.method === "PUT") {
      let input: ImageHostingUpdate;
      try { input = ImageHostingUpdate.parse(JSON.parse((await readBounded(request.body, settingsLimit, "image-hosting.settings-invalid")).toString("utf8"))); }
      catch { throw error("image-hosting.settings-invalid"); }
      return Response.json(await this.update(input), { headers: noStore });
    }
    const { destination, credentials, preview_origins } = this.record;
    if (!destination) throw error("image-hosting.disabled");
    const note = Id.safeParse(id);
    if (!note.success || !this.config.vault) throw error("image-hosting.note");
    assertNoteVisible(this.store.db, note.data);
    try { await readKnowledgeDocument(this.config.vault, note.data, { stateDir: this.config.stateDir }); }
    catch { throw error("image-hosting.note"); }
    const image = await uploadedImage(request);
    const signal = AbortSignal.any([request.signal, this.closing.signal, AbortSignal.timeout(25000)]);
    const key = formatKey(destination.prefix, image.media_type);
    let url: URL;
    try { url = await deliver(destination, credentials, image, key, this.send, signal); }
    catch { throw error("image-hosting.upstream", "INTERNAL"); }
    const validated = ImageUploadResult.safeParse({ url: url.href, media_type: image.media_type, size: image.bytes.length });
    if (!validated.success || !preview_origins.includes(url.origin) || [...url.searchParams.keys()].some(key => /^(?:x-amz-.+|x-oss-.+|x-cos-.+|signature|token|expires)$/i.test(key))) {
      throw error("image-hosting.bad-url", "INTERNAL");
    }
    return Response.json(validated.data, { status: 201, headers: noStore });
  }

  async stop(): Promise<void> { this.closing.abort(); await this.writes.drain(); }
}
