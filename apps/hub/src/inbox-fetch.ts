import { lookup } from "node:dns/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { BlockList, isIP } from "node:net";
import { CAPTURE_LIMITS, type CaptureError } from "@lumio/schema";
import { text as msg } from "./messages.ts";

export class CaptureFailure extends Error {
  constructor(readonly code: CaptureError["code"]) { super(code); }
  description(): CaptureError { return { code: this.code, message: msg(`inbox.${this.code}`) }; }
}

const blocked4 = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked4.addSubnet(address, bits, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList();
for (const [address, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blocked6.addSubnet(address, bits, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked4.check(address, "ipv4")
    : family === 6 && global6.check(address, "ipv6") && !blocked6.check(address, "ipv6");
}

const bareHost = (host: string) => host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
const defaultPort = (url: URL) => url.protocol === "https:" ? 443 : 80;

export function validateCaptureUrl(url: URL): string {
  const hostname = bareHost(url.hostname);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      !hostname || /^(?:localhost|.*\.(?:localhost|local|internal|home\.arpa))$/i.test(hostname) ||
      (!isIP(hostname) && !hostname.includes(".")) || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new CaptureFailure("blocked");
  }
  return hostname;
}

interface FetchResponse {
  status: number;
  header(name: string): string | undefined;
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  close(): void;
}
export interface CaptureNetwork {
  lookup(hostname: string): Promise<readonly string[]>;
  request(url: URL, address: string, signal: AbortSignal): Promise<FetchResponse>;
  requestThroughProxy?(url: URL, signal: AbortSignal): Promise<FetchResponse> | undefined;
  timeoutMs?: number;
}

const captureHeaders = {
  "User-Agent": "Lumio/capture", Accept: "text/html,application/xhtml+xml,application/atom+xml,application/json,application/x-bibtex,text/plain",
  "Accept-Encoding": "identity",
};

function matchesNoProxy(url: URL, list: string): boolean {
  const host = bareHost(url.hostname);
  const family = isIP(host);
  const port = Number(url.port || defaultPort(url));
  return list.split(/[,\s]+/).some(entry => {
    if (entry === "*") return true;
    if (!entry) return false;
    const cidr = /^(.+)\/(\d+)$/.exec(entry);
    if (cidr) {
      const subnet = bareHost(cidr[1]!);
      const prefix = Number(cidr[2]);
      if (!family || isIP(subnet) !== family || prefix > (family === 4 ? 32 : 128)) return false;
      const type = family === 4 ? "ipv4" : "ipv6";
      const block = new BlockList();
      block.addSubnet(subnet, prefix, type);
      return block.check(host, type);
    }
    const match = isIP(entry) ? [entry, entry] : /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!match || (match[2] && Number(match[2]) !== port)) return false;
    const domain = bareHost(match[1]!.replace(/^\*?\./, ""));
    if (family === 6 && isIP(domain) === 6) return host === bareHost(new URL(`http://[${domain}]`).hostname);
    return host === domain || (!family && host.endsWith("." + domain));
  });
}

async function proxyRequest(url: URL, proxy: string, signal: AbortSignal): Promise<FetchResponse> {
  const endpoint = new URL(proxy);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new CaptureFailure("fetch_failed");
  const response = await fetch(url, {
    // Route selection already applied NO_PROXY. A direct fallback here would skip DNS checks.
    proxy: { url: endpoint, respectNoProxy: false }, redirect: "manual", credentials: "omit",
    decompress: false, keepalive: false, signal, headers: captureHeaders,
  });
  return {
    status: response.status,
    header: name => response.headers.get(name) ?? undefined,
    body: response.body ?? [],
    close: () => { void response.body?.cancel().catch(() => {}); },
  };
}

const publicNetwork: CaptureNetwork = {
  async lookup(hostname) { return (await lookup(hostname, { all: true })).map(result => result.address); },
  request(url, address, signal) {
    return new Promise((resolve, reject) => {
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const request = (url.protocol === "https:" ? httpsGet : httpGet)({
        // Connect to the exact checked address. Retain the original HTTP host and TLS name.
        hostname: address, port: url.port || defaultPort(url),
        path: url.pathname + url.search, servername: isIP(hostname) ? undefined : hostname.replace(/\.$/, ""),
        agent: false, signal, headers: { ...captureHeaders, Host: url.host },
      }, response => resolve({
        status: response.statusCode ?? 0,
        header: name => {
          const value = response.headers[name];
          return Array.isArray(value) ? value[0] : value;
        },
        body: response,
        close: () => response.destroy(),
      }));
      request.once("error", reject);
    });
  },
};

export function captureNetwork(env: NodeJS.ProcessEnv = process.env): CaptureNetwork {
  return {
    ...publicNetwork,
    requestThroughProxy(url, signal) {
      const proxy = (url.protocol === "https:" ? env.HTTPS_PROXY : env.HTTP_PROXY)?.trim();
      if (proxy && !matchesNoProxy(url, env.NO_PROXY ?? "")) return proxyRequest(url, proxy, signal);
    },
  };
}

async function requestDirect(url: URL, host: string, signal: AbortSignal, network: CaptureNetwork): Promise<FetchResponse> {
  const addresses = isIP(host) ? [host] : await network.lookup(host);
  signal.throwIfAborted();
  if (!addresses.length) throw new CaptureFailure("fetch_failed");
  if (addresses.some(address => !isPublicAddress(address))) throw new CaptureFailure("blocked");
  return network.request(url, addresses.find(address => isIP(address) === 4) ?? addresses[0]!, signal);
}

export async function fetchCapture(
  initial: string, stopping: AbortSignal, network = captureNetwork(),
  accepted: (type: string) => boolean = type => /^(?:text\/html|application\/xhtml\+xml|text\/plain)(?:;|$)/i.test(type),
  redirectAllowed: (url: URL) => boolean = () => true,
): Promise<{ url: string; body: string; type: string }> {
  const timeout = AbortSignal.timeout(network.timeoutMs ?? CAPTURE_LIMITS.fetch_timeout_ms);
  const signal = AbortSignal.any([stopping, timeout]);
  try {
    return await raceAbort((async () => {
      let url = new URL(initial);
      for (let redirects = 0; redirects <= CAPTURE_LIMITS.max_redirects; redirects++) {
        signal.throwIfAborted();
        const host = validateCaptureUrl(url);
        if (!redirectAllowed(url)) throw new CaptureFailure("blocked");
        const response = await (network.requestThroughProxy?.(url, signal) ?? requestDirect(url, host, signal, network));
        try {
          const location = response.header("location");
          if ([301, 302, 303, 307, 308].includes(response.status) && location) {
            url = new URL(location, url);
            continue;
          }
          if ([401, 403, 407].includes(response.status)) throw new CaptureFailure("login_required");
          if (response.status < 200 || response.status >= 300) throw new CaptureFailure("fetch_failed");
          const type = response.header("content-type") ?? "";
          if (!accepted(type) || ![undefined, "identity"].includes(response.header("content-encoding"))) throw new CaptureFailure("unsupported");
          if (Number(response.header("content-length")) > CAPTURE_LIMITS.max_fetch_bytes) throw new CaptureFailure("too_large");
          const chunks: Uint8Array[] = [];
          let length = 0;
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            length += chunk.byteLength;
            if (length > CAPTURE_LIMITS.max_fetch_bytes) throw new CaptureFailure("too_large");
            chunks.push(chunk);
          }
          const charset = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(type)?.[1];
          const bytes = Buffer.concat(chunks, length);
          let decoder: TextDecoder;
          try { decoder = new TextDecoder((charset ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0]); }
          catch { decoder = new TextDecoder(); }
          return { url: url.href, body: decoder.decode(bytes), type };
        } finally { response.close(); }
      }
      throw new CaptureFailure("fetch_failed");
    })(), signal);
  } catch (cause) {
    if (cause instanceof CaptureFailure) throw cause;
    throw new CaptureFailure(timeout.aborted ? "timeout" : "fetch_failed");
  }
}

function raceAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
