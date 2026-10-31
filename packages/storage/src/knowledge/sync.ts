import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { CoreError } from "@lumio/foundation";
import { fillMetadata, type FillContext } from "@lumio/knowledge";
import { newId } from "@lumio/foundation";
import { parseFrontmatter } from "@lumio/knowledge";
import { scanVault, vaultFileAt, type VaultFile } from "./vault.ts";
import { writeFileAtomic } from "./write.ts";

export interface SyncOptions {
  dryRun?: boolean;
  log?: (line: string) => void;
  writeFile?: typeof writeFileAtomic;
  context?: FillContext;
  onResult?: (result: SyncFileResult) => void;
}
export interface SyncFileResult {
  path: string;
  filled: boolean;
  problem: boolean;
  skipped: boolean;
  line?: string;
  code?: string;
}
export interface SyncResult { scanned: number; filled: number; problems: number; skipped: number }

function context(): FillContext {
  const now = new Date();
  return { now, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    newId: (prefix) => newId(prefix, now, randomBytes) };
}

async function complete(file: VaultFile, options: SyncOptions): Promise<SyncFileResult> {
  const result: SyncFileResult = { path: file.relativePath, filled: false, problem: false, skipped: false };
  try {
    const source = await readFile(file.path);
    const parsed = parseFrontmatter(source);
    const info = await stat(file.path);
    const { patch, issues } = fillMetadata({ type: file.type, frontmatter: parsed.data,
      fileName: basename(file.path, ".md"), birthtime: info.birthtime, mtime: info.mtime }, options.context ?? context());
    const keys = Object.keys(patch);
    if (keys.length) {
      const output = parsed.render(patch);
      if (!options.dryRun) await (options.writeFile ?? writeFileAtomic)(file.path, output, { expectedContent: source });
      result.filled = true;
    }
    result.problem = issues.length > 0;
    const details = [...keys.map((key) => `+${key}`), ...issues.map((issue) => `${issue.path}: ${issue.message}`)];
    if (details.length) result.line = `${issues.length ? "问题" : "补全"}  ${file.relativePath}  ${details.join(" ")}`;
  } catch (cause) {
    result.skipped = true;
    if (cause instanceof CoreError) result.code = cause.code;
    result.line = `跳过  ${file.relativePath}  ${cause instanceof CoreError ? cause.message : "无法读取或处理文件"}`;
  }
  if (result.line) options.log?.(result.line);
  options.onResult?.(result);
  return result;
}

/** Ineligible or deleted paths are ignored, using the same rules as scanVault. */
export async function syncFile(root: string, path: string, options: SyncOptions = {}): Promise<SyncFileResult | undefined> {
  const file = await vaultFileAt(root, path);
  return file ? complete(file, options) : undefined;
}

export async function syncVault(root: string, options: SyncOptions = {}): Promise<SyncResult> {
  const files = await scanVault(root);
  const shared = { ...options, context: options.context ?? context() };
  const summary: SyncResult = { scanned: files.length, filled: 0, problems: 0, skipped: 0 };
  for (const file of files) {
    const result = await complete(file, shared);
    summary.filled += Number(result.filled); summary.problems += Number(result.problem); summary.skipped += Number(result.skipped);
  }
  options.log?.(`完成：扫描 ${summary.scanned} 个，补全 ${summary.filled} 个，问题 ${summary.problems} 个，跳过 ${summary.skipped} 个`);
  return summary;
}
