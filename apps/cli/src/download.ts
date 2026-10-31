import { downloadRelease as sharedDownload, type DownloadOptions } from "@lumio/platform";
export { DownloadError } from "@lumio/platform";
export type { DownloadOptions } from "@lumio/platform";

/** The application owns terminal detection and display; transport is shared. */
export function downloadRelease(url: string, options: DownloadOptions = {}): Promise<Buffer> {
  return sharedDownload(url, { ...options, tty: options.tty ?? process.stderr.isTTY, progress: options.progress ?? ((line) => { process.stderr.write(line + "\n"); }) });
}
