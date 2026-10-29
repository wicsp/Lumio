// Identical in CLI/runtime: apps must not import one another.
export class DownloadError extends Error { readonly code = "DOWNLOAD_FAILED"; }
export interface DownloadOptions {
  fetch?: typeof globalThis.fetch; tty?: boolean; progress?: (line: string) => void;
  connectMs?: number; windowMs?: number; now?: () => number;
}
export async function downloadRelease(url: string, options: DownloadOptions = {}): Promise<Buffer> {
  const controller = new AbortController(), now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined, interval: ReturnType<typeof setInterval> | undefined;
  let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } | undefined;
  let timeout = false, downloaded = 0, windowBytes = 0, windowStart = now(), lastProgress = now();
  const windowMs = options.windowMs ?? 60_000;
  let rejectTimeout: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const expire = () => {
    timeout = true;
    rejectTimeout(new DownloadError("下载太慢或卡住，请检查网络或代理（https_proxy）后重试"));
    controller.abort(); void reader?.cancel().catch(() => {});
  };
  const progress = options.progress ?? ((line: string) => process.stderr.write(line + "\n"));
  try {
    timer = setTimeout(expire, options.connectMs ?? 20_000);
    const response = await Promise.race([(options.fetch ?? globalThis.fetch)(url, { redirect: "follow", signal: controller.signal }), deadline]);
    clearTimeout(timer);
    if (!response.ok) throw new DownloadError(`下载失败：HTTP ${response.status}，请检查网络与版本`);
    if (!response.body) throw new DownloadError("下载响应没有内容");
    const size = Number(response.headers.get("content-length")), total = size > 0 ? size : undefined;
    const report = () => progress(`已下载 ${downloaded} / ${total ?? "未知"} 字节 / ${total ? `${Math.min(100, downloaded / total * 100).toFixed(1)}%` : "百分比未知"}`);
    reader = response.body.getReader(); windowStart = now();
    interval = setInterval(() => {
      const elapsed = now() - windowStart;
      if (elapsed >= windowMs) {
        if ((downloaded - windowBytes) / (elapsed / 1000) < 1024) { expire(); return; }
        windowStart = now(); windowBytes = downloaded;
      }
      if ((options.tty ?? process.stderr.isTTY) && now() - lastProgress >= 1000) { report(); lastProgress = now(); }
    }, Math.min(1000, windowMs));
    const chunks: Uint8Array[] = [];
    while (true) {
      const part = await Promise.race([reader!.read(), deadline]);
      if (part.done) break;
      chunks.push(part.value!); downloaded += part.value!.byteLength;
    }
    if (options.tty ?? process.stderr.isTTY) report();
    return Buffer.concat(chunks);
  } catch (cause) {
    if (timeout) throw new DownloadError("下载太慢或卡住，请检查网络或代理（https_proxy）后重试");
    if (cause instanceof DownloadError) throw cause;
    throw new DownloadError("下载失败，请检查网络或代理（https_proxy）后重试");
  } finally {
    clearTimeout(timer); clearInterval(interval);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
