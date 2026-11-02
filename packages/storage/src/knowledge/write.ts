import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { CoreError } from "@lumio/foundation";

export interface WriteOptions {
  overwrite?: boolean;
  expectedContent?: Uint8Array;
  beforeCommit?: () => void | Promise<void>;
}

/** Replace through a sibling temporary file; guard against edits since the read. */
export async function writeFileAtomic(path: string, content: Uint8Array, options: WriteOptions = {}): Promise<boolean> {
  let temp: string | undefined;
  async function checkOriginal(): Promise<void> {
    if (options.expectedContent === undefined) return;
    let current: Buffer;
    try { current = await readFile(path); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      throw new CoreError("FILE_CHANGED", "文件在处理中被修改，请重新运行", { cause });
    }
    if (!current.equals(options.expectedContent)) {
      throw new CoreError("FILE_CHANGED", "文件在处理中被修改，请重新运行");
    }
  }
  try {
    await checkOriginal();
    let mode = 0o666;
    try {
      if (options.overwrite === false) {
        // link publishes a complete file without replacing another creator's file.
        await stat(path);
        throw new CoreError("FILE_EXISTS", `文件已存在：${path}`);
      }
      if ((await readFile(path)).equals(content)) return false;
      mode = (await stat(path)).mode & 0o777;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const handle = await open(temp, "wx", mode);
    try { await handle.writeFile(content); }
    finally { await handle.close(); }
    await options.beforeCommit?.();
    // Keep this read immediately before rename. This is an optimistic content
    // check, not a filesystem compare-and-swap against concurrent editors.
    await checkOriginal();
    if (options.overwrite === false) await link(temp, path);
    else {
      await rename(temp, path);
      temp = undefined;
    }
    return true;
  } catch (cause) {
    if (cause instanceof CoreError) throw cause;
    if (options.overwrite === false && (cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CoreError("FILE_EXISTS", `文件已存在：${path}`, { cause });
    }
    throw new CoreError("WRITE_FAILED", `无法安全写入文件：${path}`, { cause });
  } finally {
    if (temp) await unlink(temp).catch(() => {});
  }
}
