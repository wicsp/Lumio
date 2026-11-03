import { downloadRelease as sharedDownload, type DownloadOptions, createProgressLine } from "@lumio/platform";
export { DownloadError } from "@lumio/platform";
export type { DownloadOptions } from "@lumio/platform";

/** The application owns terminal detection and display; transport is shared. */
export function downloadRelease(url: string, options: DownloadOptions = {}): Promise<Buffer> {
  const onProgress = options.onProgress ?? createProgressLine({ label: "下载 Lumio", tty: options.tty ?? process.stderr.isTTY ?? false,
    columns: () => process.stderr.columns, write: options.progress ?? (chunk => { process.stderr.write(chunk); }) });
  return sharedDownload(url, { ...options, onProgress });
}
