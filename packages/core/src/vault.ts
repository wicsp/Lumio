import { lstat, open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CoreError } from "./errors.ts";
import type { EntityType } from "./fill.ts";

/**
 * vault 的路径 → 类型映射（ADR 0012）。这是唯一的映射来源：其他代码通过
 * `entityDirectory()` 等函数取得路径，不得硬编码 `library/papers/` 之类的字符串。
 *
 * 类型目录下可以有任意子文件夹，子文件夹只用于浏览，不影响类型。
 * 不在表中的位置（`research/reports/`、`files/`、根目录等）不会被扫描。
 */
export const VAULT_LAYOUT = [
  { dir: "library/papers", type: "paper", private: false },
  { dir: "library/sources", type: "source", private: false },
  { dir: "research/ideas", type: "idea", private: false },
  { dir: "research/experiments", type: "experiment", private: false },
  { dir: "plan/projects", type: "project", private: false },
  { dir: "plan/tasks", type: "task", private: false },
  { dir: "create/posts", type: "post", private: false },
  { dir: "life/assets", type: "asset", private: true },
] as const satisfies readonly { dir: string; type: EntityType; private: boolean }[];

type LayoutEntry = (typeof VAULT_LAYOUT)[number];

function entryOf(type: EntityType): LayoutEntry {
  const entry = VAULT_LAYOUT.find((e) => e.type === type);
  if (!entry) throw new CoreError("UNKNOWN_ENTITY_TYPE", `vault 中没有类型 ${type} 的目录`);
  return entry;
}

/** 某类实体所在的目录（相对 vault 根目录，使用 `/` 分隔）。 */
export function entityDirectory(type: EntityType): string {
  return entryOf(type).dir;
}

/** 某类实体是否属于私密实体（ADR 0012 第 6 节）。 */
export function isPrivateType(type: EntityType): boolean {
  return entryOf(type).private;
}

/** 由相对路径判断实体类型；不在任何类型目录下时返回 undefined。 */
export function entityTypeOfPath(relativePath: string): EntityType | undefined {
  const normalized = relativePath.split(sep).join("/");
  return VAULT_LAYOUT.find((e) => normalized.startsWith(`${e.dir}/`))?.type;
}

export interface VaultFile { path: string; relativePath: string; type: EntityType; private: boolean }

export function resolveVault(explicit: string | undefined, env: string | undefined): string {
  const path = explicit ?? env;
  if (!path) throw new CoreError("VAULT_REQUIRED", "请使用 --vault <路径> 或设置 LUMIO_VAULT");
  return path;
}

const EXCALIDRAW_SUFFIX = ".excalidraw.md";
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
export function isVaultNotePath(path: string): boolean {
  return !isAbsolute(path) && path.endsWith(".md") && !path.toLowerCase().endsWith(EXCALIDRAW_SUFFIX)
    && path.split(/[\\/]/).every((part) => part !== "" && !part.startsWith("."))
    && entityTypeOfPath(path) !== undefined;
}

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
