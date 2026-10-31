import { lstat, open, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { CoreError } from "@lumio/foundation";
import { VAULT_LAYOUT, EXCALIDRAW_SUFFIX, isVaultNotePath, entityTypeOfPath, isPrivateType, type VaultFile, type LayoutEntry, type EntityType } from "@lumio/knowledge";
export type { VaultFile } from "@lumio/knowledge";

const HEAD_BYTES = 4096;

/** Excalidraw 画板不是实体：按文件名或 frontmatter 中的 `excalidraw-plugin` 键识别（ADR 0012 第 1 节）。 */
async function isExcalidraw(path: string, name: string): Promise<boolean> {
  if (name.toLowerCase().endsWith(EXCALIDRAW_SUFFIX)) return true;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8").replace(/^﻿/, "");
    const match = /^---\r?\n([\s\S]*?)(?:\r?\n)(?:---|\.\.\.)(?:\r?\n|$)/.exec(head);
    return match !== null && /^excalidraw-plugin\s*:/m.test(match[1]!);
  } finally {
    await handle.close();
  }
}

/** Cheap event filter; filesystem and Excalidraw checks follow in vaultFileAt. */

export async function vaultFileAt(root: string, path: string): Promise<VaultFile | undefined> {
  const relativePath = relative(resolve(root), resolve(root, path));
  if (!isVaultNotePath(relativePath)) return;
  const parts = relativePath.split(sep);
  let target = resolve(root);
  try {
    for (const [index, part] of parts.entries()) {
      target = join(target, part);
      const info = await lstat(target);
      if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) return;
    }
    if (await isExcalidraw(target, parts.at(-1)!)) return;
    const type = entityTypeOfPath(relativePath)!;
    return { path: target, relativePath, type, private: isPrivateType(type) };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CoreError("VAULT_READ_FAILED", "无法读取 vault 文件", { cause });
  }
}

export async function scanVault(root: string, types?: readonly EntityType[]): Promise<VaultFile[]> {
  const files: VaultFile[] = [];
  async function walk(dir: string, entry: LayoutEntry) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of entries) {
      if (item.name.startsWith(".")) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path, entry);
      else if (item.isFile() && item.name.endsWith(".md") && !(await isExcalidraw(path, item.name))) {
        files.push({ path, relativePath: relative(root, path), type: entry.type, private: entry.private });
      }
    }
  }
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("vault 路径不是目录");
    for (const entry of VAULT_LAYOUT) {
      if (types && !types.includes(entry.type)) continue;
      const path = join(root, ...entry.dir.split("/"));
      let info;
      try { info = await lstat(path); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw cause;
      }
      if (info.isDirectory()) await walk(path, entry);
    }
    return files;
  } catch (cause) {
    throw new CoreError("VAULT_READ_FAILED", `无法扫描 vault：${root}`, { cause });
  }
}
