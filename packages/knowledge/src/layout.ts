import { isAbsolute, sep } from "node:path";
import { CoreError } from "@lumio/foundation";
import type { EntityType } from "./fill.ts";

export const EXCALIDRAW_SUFFIX = ".excalidraw.md";

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
  { dir: "plan/routines", type: "routine", private: false },
  { dir: "create/posts", type: "post", private: false },
  { dir: "life/assets", type: "asset", private: true },
] as const satisfies readonly { dir: string; type: EntityType; private: boolean }[];

export type LayoutEntry = (typeof VAULT_LAYOUT)[number];

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

/** Syntactic eligibility; filesystem checks belong to Storage. */
export function isVaultNotePath(path: string): boolean {
  return !isAbsolute(path) && path.endsWith(".md") && !path.toLowerCase().endsWith(EXCALIDRAW_SUFFIX)
    && path.split(/[\\/]/).every((part) => part !== "" && !part.startsWith("."))
    && entityTypeOfPath(path) !== undefined;
}

