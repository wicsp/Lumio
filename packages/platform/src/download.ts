import { type Text, untranslated } from "./language.ts";
import type { DownloadProgress } from "./terminal.ts";

// Shared release transport; callers own terminal detection and display.
export class DownloadError extends Error {
  readonly code = "DOWNLOAD_FAILED";
  constructor(public readonly params: { key: string; args: readonly unknown[] }) { super("DOWNLOAD_FAILED"); this.name = "DownloadError"; }
}
export class DownloadLimitError extends DownloadError {
  constructor() { super({ key: "download.download_failed_check_network_or_proxy_https_proxy_and_retry", args: [] }); }
}
export interface DownloadOptions {
  text?: Text; fetch?: typeof globalThis.fetch; tty?: boolean;
  /** Legacy source transport callback. New displays consume onProgress. */
  progress?: (line: string) => void;
  onProgress?: (progress: DownloadProgress) => void;
  connectMs?: number; windowMs?: number; now?: () => number;
  maxBytes?: number;
}
export async function downloadRelease(url: string, options: DownloadOptions = {}): Promise<Buffer> {
  const msg = options.text ?? untranslated;
  const controller = new AbortController(), now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined, interval: ReturnType<typeof setInterval> | undefined;
  let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } | undefined;
  let timeout = false, downloaded = 0, windowBytes = 0, windowStart = now(), lastProgress = now();
  const windowMs = options.windowMs ?? 60_000;
  let rejectTimeout: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const expire = () => {
    timeout = true;
    rejectTimeout(new DownloadError({ key: "download.download_stalled_or_too_slow_check_network_or_proxy_https_proxy_and", args: [] }));
    controller.abort(); void reader?.cancel().catch(() => {});
  };
  const progress = options.progress ?? (() => {});
  let started: number | undefined, total: number | undefined, finished = false;
  const reportProgress = (done: boolean, failed = false) => options.onProgress?.({ downloaded, total,
    bytesPerSecond: started === undefined ? 0 : downloaded / Math.max(0.001, (now() - started) / 1000), done, ...(failed ? { failed } : {}) });
  try {
    timer = setTimeout(expire, options.connectMs ?? 20_000);
    const response = await Promise.race([(options.fetch ?? globalThis.fetch)(url, { redirect: "follow", signal: controller.signal }), deadline]);
    clearTimeout(timer);
    if (!response.ok) throw new DownloadError({ key: "download.download_failed_http_check_network_and_version", args: [response.status] });
    if (!response.body) throw new DownloadError({ key: "download.download_response_has_no_body", args: [] });
    const size = Number(response.headers.get("content-length")); total = Number.isFinite(size) && size > 0 ? size : undefined;
    if (options.maxBytes !== undefined && total !== undefined && total > options.maxBytes) {
      await response.body.cancel(); throw new DownloadLimitError();
    }
    started = now(); reportProgress(false);
    const report = () => progress(msg("Downloaded ${0} / ${1} bytes / ${2}", downloaded, total ?? msg("Unknown"), total ? `${Math.min(100, downloaded / total * 100).toFixed(1)}%` : msg("Unknown percentage")));
    reader = response.body.getReader(); windowStart = now();
    interval = setInterval(() => {
      const elapsed = now() - windowStart;
      if (elapsed >= windowMs) {
        if ((downloaded - windowBytes) / (elapsed / 1000) < 1024) { expire(); return; }
        windowStart = now(); windowBytes = downloaded;
      }
      if (now() - lastProgress >= 1000) {
        reportProgress(false);
        if (!options.onProgress && options.tty) report();
        lastProgress = now();
      }
    }, Math.min(1000, windowMs));
    const chunks: Uint8Array[] = [];
    while (true) {
      const part = await Promise.race([reader!.read(), deadline]);
      if (part.done) break;
      downloaded += part.value!.byteLength;
      if (options.maxBytes !== undefined && downloaded > options.maxBytes) throw new DownloadLimitError();
      chunks.push(part.value!);
    }
    reportProgress(true); finished = true;
    if (!options.onProgress && options.tty) report();
    return Buffer.concat(chunks);
  } catch (cause) {
    if (started !== undefined && !finished) reportProgress(true, true);
    if (timeout) throw new DownloadError({ key: "download.download_stalled_or_too_slow_check_network_or_proxy_https_proxy_and", args: [] });
    if (cause instanceof DownloadError) throw cause;
    throw new DownloadError({ key: "download.download_failed_check_network_or_proxy_https_proxy_and_retry", args: [] });
  } finally {
    clearTimeout(timer); clearInterval(interval);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
