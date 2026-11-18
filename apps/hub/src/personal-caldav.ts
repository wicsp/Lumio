import { XMLValidator } from "fast-xml-parser";
import { DOMParser } from "linkedom";
import { boundedText } from "./bounded-body.ts";

type XmlElement = NonNullable<ReturnType<DOMParser["parseFromString"]>["documentElement"]>;
interface ChangedCalendarResource { href: string; etag: string; text: string }
type Change = { href: string; etag: string } | { href: string; deleted: true };
type SyncPage = { token: string; changes: Change[]; truncated: boolean };

export class CaldavError extends Error {
  constructor(readonly code: "INVALID" | "UNAVAILABLE" | "CONFLICT" | "CURSOR_EXPIRED") {
    super(`CalDAV ${code.toLowerCase().replaceAll("_", " ")}`);
    this.name = "CaldavError";
  }
}

const REPORT_LIMIT = 4 * 1024 * 1024;
const RESOURCE_LIMIT = 1024 * 1024;
const MAX_PAGES = 32;
const MAX_RESOURCES = 5000;
const xml = (input: string) => input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const strongEtag = (value: string | null): value is string => value !== null && /^"[\x21\x23-\x7e]*"$/.test(value);

function davName(element: XmlElement, name: string): boolean {
  const colon = element.tagName.indexOf(":");
  if (element.tagName.slice(colon + 1) !== name) return false;
  const declaration = colon < 0 ? "xmlns" : `xmlns:${element.tagName.slice(0, colon)}`;
  for (let ancestor: XmlElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const namespace = ancestor.getAttribute(declaration);
    if (namespace !== null) return namespace === "DAV:";
  }
  return false;
}

const children = (element: XmlElement, name: string) => Array.from(element.children).filter(child => davName(child, name));
const one = (element: XmlElement, name: string): XmlElement | undefined => {
  const matches = children(element, name);
  if (matches.length > 1) throw new CaldavError("INVALID");
  return matches[0];
};
const content = (element: XmlElement, name: string) => one(element, name)?.textContent?.trim();
const httpStatus = (element: XmlElement) => /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(content(element, "status") ?? "")?.[1];

function reportRoot(text: string): XmlElement {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text) || XMLValidator.validate(text) !== true) {
    throw new CaldavError("INVALID");
  }
  const root = new DOMParser().parseFromString(text, "text/xml").documentElement;
  if (!root) throw new CaldavError("INVALID");
  return root;
}

function calendarUrl(input: string, parent?: URL): URL {
  try {
    return new URL(input, parent);
  } catch {
    throw new CaldavError("INVALID");
  }
}

/**
 * A transport for one explicitly configured Radicale collection. DAV response
 * paths are untrusted and never expand the scope of the account credentials.
 */
export class CaldavCollection {
  private readonly collection: URL;
  private readonly authorization: string;

  constructor(url: string, username: string, password: string, private readonly fetcher: typeof fetch = fetch) {
    this.collection = calendarUrl(url);
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    if (this.collection.protocol !== "https:" || this.collection.username || this.collection.password ||
      this.collection.search || this.collection.hash || !this.collection.pathname.endsWith("/") ||
      !username || username.includes(":") || !password || /%2f|%5c|%25/i.test(this.collection.pathname)) {
      throw new CaldavError("INVALID");
    }
  }

  private target(href: string, allowCollection = false): URL {
    if (!href || /[\\\x00-\x20\x7f]|%2f|%5c|%25/i.test(href)) throw new CaldavError("INVALID");
    const url = calendarUrl(href, this.collection);
    const parent = this.collection.pathname;
    const name = url.pathname.slice(parent.length);
    if (url.origin !== this.collection.origin || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(parent) || name.includes("/") || (!allowCollection && !name)) {
      throw new CaldavError("INVALID");
    }
    return url;
  }

  private async request(url: URL, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    try {
      return await this.fetcher(url, {
        ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        headers: { ...init.headers, Authorization: this.authorization },
      });
    } catch {
      throw new CaldavError("UNAVAILABLE");
    }
  }

  private async page(cursor: string | null, signal?: AbortSignal): Promise<SyncPage> {
    const response = await this.request(this.collection, {
      method: "REPORT", signal,
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="utf-8"?>` +
        `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${xml(cursor ?? "")}</d:sync-token>` +
        `<d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
    });
    if (response.status !== 207 && !(response.status === 403 && cursor !== null)) {
      await response.body?.cancel();
      throw new CaldavError("UNAVAILABLE");
    }
    const root = reportRoot(await boundedText(response.body, REPORT_LIMIT));
    if (response.status === 403) {
      if (davName(root, "error") && one(root, "valid-sync-token")) throw new CaldavError("CURSOR_EXPIRED");
      throw new CaldavError("UNAVAILABLE");
    }
    const token = content(root, "sync-token");
    if (!davName(root, "multistatus") || !token) throw new CaldavError("INVALID");

    const changes: Change[] = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const row of children(root, "response")) {
      const href = this.target(content(row, "href") ?? "", true).pathname;
      if (seen.has(href)) throw new CaldavError("INVALID");
      seen.add(href);
      const status = httpStatus(row);
      if (href === this.collection.pathname) {
        if (status !== "507" || truncated) throw new CaldavError("INVALID");
        truncated = true;
      } else if (status === "404") {
        changes.push({ href, deleted: true });
      } else {
        if (status !== undefined) throw new CaldavError("UNAVAILABLE");
        const propstat = children(row, "propstat").filter(element => httpStatus(element) === "200");
        const prop = propstat.length === 1 ? one(propstat[0]!, "prop") : undefined;
        const etag = prop ? content(prop, "getetag") ?? null : null;
        if (!strongEtag(etag)) throw new CaldavError("UNAVAILABLE");
        changes.push({ href, etag });
      }
    }
    return { token, changes, truncated };
  }

  async pull(expectedToken: string | null, signal?: AbortSignal) {
    try {
      return await this.scan(expectedToken, signal);
    } catch (error) {
      if (expectedToken === null || !(error instanceof CaldavError) || error.code !== "CURSOR_EXPIRED") throw error;
      return this.scan(null, signal);
    }
  }

  private async scan(start: string | null, signal?: AbortSignal) {
    let cursor = start;
    const changes = new Map<string, Change>();
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const page = await this.page(cursor, signal);
      for (const change of page.changes) changes.set(change.href, change);
      if (changes.size > MAX_RESOURCES || (page.truncated && cursor === page.token)) throw new CaldavError("UNAVAILABLE");
      cursor = page.token;
      if (page.truncated) continue;
      const resources: ChangedCalendarResource[] = [];
      const deleted: string[] = [];
      let bytes = 0;
      for (const change of changes.values()) {
        if ("deleted" in change) deleted.push(change.href);
        else {
          const item = await this.read(change.href, change.etag, signal);
          if (!item) throw new CaldavError("CONFLICT");
          bytes += Buffer.byteLength(item.text);
          if (bytes > 16 * REPORT_LIMIT) throw new CaldavError("UNAVAILABLE");
          resources.push(item);
        }
      }
      return { mode: start === null ? "full" as const : "incremental" as const, token: cursor, resources, deleted };
    }
    throw new CaldavError("UNAVAILABLE");
  }

  async read(href: string, expectedEtag?: string, signal?: AbortSignal): Promise<ChangedCalendarResource | undefined> {
    const url = this.target(href);
    const response = await this.request(url, { method: "GET", signal, headers: expectedEtag ? { "If-Match": expectedEtag } : {} });
    const etag = response.headers.get("etag");
    if (response.status !== 200 || !strongEtag(etag) || (expectedEtag !== undefined && expectedEtag !== etag)) {
      await response.body?.cancel();
      if (response.status === 404) return;
      throw new CaldavError(response.status === 200 || response.status === 412 ? "CONFLICT" : "UNAVAILABLE");
    }
    return { href: url.pathname, etag, text: await boundedText(response.body, RESOURCE_LIMIT) };
  }

  async write(href: string, text: string, condition: { mode: "create" } | { mode: "update"; etag: string }, signal?: AbortSignal): Promise<void> {
    if (Buffer.byteLength(text) > RESOURCE_LIMIT || (condition.mode === "update" && !strongEtag(condition.etag))) {
      throw new CaldavError("INVALID");
    }
    const url = this.target(href);
    const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
    if (condition.mode === "create") headers["If-None-Match"] = "*";
    else headers["If-Match"] = condition.etag;
    const response = await this.request(url, { method: "PUT", signal, headers, body: text });
    await response.body?.cancel();
    if (response.status === 412) throw new CaldavError("CONFLICT");
    if (!response.ok) throw new CaldavError("UNAVAILABLE");
  }
}
