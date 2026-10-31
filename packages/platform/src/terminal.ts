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
