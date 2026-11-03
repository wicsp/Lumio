import { closeSync, openSync, readSync, writeSync } from "node:fs";

/**
 * 在终端里问一句（P2-11）。直接读写 `/dev/tty`，不用 readline：
 * `curl … | sh` 时标准输入是管道，用 readline 读 `/dev/tty` 的话，在 macOS 的真实终端里完全无法输入。
 * 终端处于普通的行模式，回显与退格由终端自己处理；这里只按行读取。
 */
export interface Terminal { path: string }

/** 能打开 `/dev/tty` 才算交互终端（launchd、systemd、CI 里都打不开）。 */
export function openTerminal(path = "/dev/tty"): Terminal | undefined {
  try { closeSync(openSync(path, "r+")); return { path }; } catch { return undefined; }
}

/** 写出提示，读一行回答（不含换行）。读到文件结尾（Ctrl-D）时返回已读到的内容；终端不可用时返回 undefined。 */
export function askTerminal(terminal: Terminal, question: string): string | undefined {
  let fd: number;
  try { fd = openSync(terminal.path, "r+"); } catch { return undefined; }
  try {
    writeSync(fd, question);
    const bytes: number[] = [];
    const one = Buffer.alloc(1);
    for (;;) {
      const n = readSync(fd, one, 0, 1, null);
      if (n === 0 || one[0] === 0x0a) break;
      bytes.push(one[0]!);
      if (bytes.length > 4096) break;
    }
    return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
  } catch { return undefined; } finally { closeSync(fd); }
}

export interface TerminalOutput { isTTY?: boolean; columns?: number }
export function isTerminal(output: TerminalOutput): boolean { return output.isTTY === true; }
/** FORCE_COLOR takes precedence, including when NO_COLOR is also present. */
export function allowsColor(output: TerminalOutput, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return env.NO_COLOR === undefined && env.TERM !== "dumb" && isTerminal(output);
}
export function terminalColors(enabled: boolean) {
  const color = (code: number) => (text: string) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return { green: color(32), red: color(31), yellow: color(33) };
}
export function formatSize(bytes: number): string {
  const size = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const unit = Math.min(3, Math.floor(Math.log2(Math.max(1, size)) / 10));
  return `${(size / 1024 ** unit).toFixed(1)} ${["B", "KB", "MB", "GB"][unit]}`;
}
export function formatSpeed(bytesPerSecond: number): string { return `${formatSize(bytesPerSecond)}/s`; }
export interface DownloadProgress { downloaded: number; total?: number; bytesPerSecond: number; done: boolean; failed?: boolean }
export interface ProgressLineOptions {
  label: string; tty: boolean; columns?: () => number; write: (chunk: string) => void;
}
/** The sink receives complete terminal control sequences/newlines, not console.log lines. */
export function createProgressLine(options: ProgressLineOptions): (progress: DownloadProgress) => void {
  let started = false, finished = false, previousWidth = 0;
  return (progress) => {
    if (finished || (!options.tty && started && !progress.done)) return;
    const percent = progress.total ? `${Math.min(100, progress.downloaded / progress.total * 100).toFixed(0)}%` : "?%";
    const numbers = `${percent}  ${formatSize(progress.downloaded)} / ${progress.total ? formatSize(progress.total) : "未知"}  ${formatSpeed(progress.bytesPerSecond)}${progress.failed ? "（下载失败）" : ""}`;
    const columns = Math.max(1, options.columns?.() ?? 80);
    let label = options.label;
    // Leave a column spare so writing never wraps before the next carriage return.
    const width = (value: string) => Bun.stringWidth(value);
    const barWidth = Math.min(20, columns - 1 - width(`${label}  ${numbers}`) - 4);
    let bar = "";
    if (options.tty && barWidth >= 5 && progress.total) {
      const filled = Math.round(barWidth * Math.min(1, progress.downloaded / progress.total));
      bar = `[${"█".repeat(filled)}${"░".repeat(barWidth - filled)}]  `;
    }
    if (options.tty && width(`${label}  ${numbers}`) >= columns) {
      while (label && width(`${label}…  ${numbers}`) >= columns) label = label.slice(0, -1);
      label = label ? `${label}…` : "";
    }
    let line = `${label ? label + "  " : ""}${bar}${numbers}`;
    // At extremely narrow widths even the numbers cannot fit; retain their leading portion.
    if (options.tty) while (line && width(line) >= columns) line = line.slice(0, -1);
    const lineWidth = width(line);
    options.write(options.tty ? `\r${line}${" ".repeat(Math.max(0, Math.min(previousWidth, columns - 1) - lineWidth))}${progress.done ? "\n" : ""}` : `${line}\n`);
    previousWidth = lineWidth; started = true; finished = progress.done;
  };
}
