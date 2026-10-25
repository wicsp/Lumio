import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  entityTypeOfPath, isPrivateType, isVaultNotePath, openVaultGit, syncFile, syncVault, updateIndex, vaultFileAt,
  VAULT_LAYOUT, type SyncFileResult, type SyncOptions, type VaultGit,
} from "@lumio/core";
import { textContainsCardNumber } from "@lumio/schema";

export interface HubStatus {
  watching: boolean;
  last_full_sync: string | null;
  pending_files: number;
  issues: string[];
}
export interface WatchClock {
  now(): number;
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}
const systemClock: WatchClock = {
  now: Date.now, set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export interface WatchOptions {
  log?: (line: string) => void;
  clock?: WatchClock;
  watch?: typeof watch;
  git?: (root: string) => Promise<VaultGit | undefined>;
  syncOptions?: SyncOptions;
  onProcess?: (path: string) => void;
}

// Schema diagnostics can mention user-controlled YAML keys. Never log card text.
function safe(line: string): string {
  return line.replace(/\d(?:[\d -]*\d)?/g, (value) => textContainsCardNumber(value) ? "[已隐藏]" : value);
}
function privatePath(path: string): boolean {
  const type = entityTypeOfPath(path);
  return VAULT_LAYOUT.some((entry) => entry.private && (path === entry.dir.split("/")[0] || path.startsWith(`${entry.dir.split("/")[0]}/`)))
    || (type !== undefined && isPrivateType(type));
}

function changesAutosave(path: string): boolean {
  return !isAbsolute(path) && path.split(/[\\/]/).every((part) => part !== "" && part !== ".." && !part.startsWith("."));
}

export async function startVaultWatch(config: { vault: string; stateDir: string; autosaveIdle: number }, options: WatchOptions = {}) {
  const clock = options.clock ?? systemClock;
  const log = (line: string) => options.log?.(safe(line));
  const git = await (options.git ?? openVaultGit)(config.vault);
  if (!git) log("vault git 不可用，跳过自动提交");
  const issues: { path: string; line: string }[] = [];
  let watching = false, stopped = false;
  let lastFullSync: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  let idleTimer: unknown;
  let lastChange = clock.now();
  const debounce = new Map<string, unknown>();
  let watcher: FSWatcher | undefined;

  function report(path: string, line: string) {
    const clean = safe(line);
    if (issues.some((issue) => issue.path === path && issue.line === clean)) return;
    issues.push({ path, line: clean });
    if (issues.length > 20) issues.shift();
    log(clean);
  }
  function result(result: SyncFileResult) {
    if (result.code === "FILE_CHANGED") return;
    if ((result.problem || result.skipped) && result.line) report(result.path, result.line);
  }
  function enqueue(action: () => Promise<void>) {
    queue = queue.then(async () => { if (!stopped) await action(); }).catch(() => {
      report("", "跳过  vault  无法处理文件变化或更新索引");
    });
  }
  function armIdle(delay = config.autosaveIdle * 1000) {
    if (stopped || !git) return;
    if (idleTimer !== undefined) clock.clear(idleTimer);
    idleTimer = clock.set(() => { idleTimer = undefined; enqueue(autosave); }, delay);
  }
  async function autosave() {
    if (!git) return;
    const remaining = config.autosaveIdle * 1000 - (clock.now() - lastChange);
    if (remaining > 0) { armIdle(remaining); return; }
    try {
      const paths = await git.changedFiles();
      const eligible: string[] = [];
      let retry = false;
      for (const path of paths) {
        try {
          // Never follow symlinks to read data outside the vault.
          let target = config.vault;
          const parts = path.split("/");
          let deleted = false, regular = true;
          for (const [index, part] of parts.entries()) {
            target = join(target, part);
            try {
              const info = await lstat(target);
              if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) { regular = false; break; }
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
              deleted = true; break;
            }
          }
          if (!regular) { report(path, `跳过  ${path}  无法检查非普通文件`); continue; }
          const source = deleted ? null : await readFile(target);
          if (source && textContainsCardNumber(source.toString("utf8"))) {
            // A blocked entry contains only its path, never content or diagnostics.
            report(path, path); continue;
          }
          await git.add(path, source);
          eligible.push(path);
        } catch { retry = true; report(path, `跳过  ${path}  无法检查或暂存文件`); }
      }
      // Processing may have observed new edits while reading/staging files.
      if (clock.now() - lastChange < config.autosaveIdle * 1000) { armIdle(); return; }
      if (eligible.length) await git.commit(eligible, `lumio: auto-save ${eligible.length} files`);
      if (retry) { log("vault 自动提交失败，下一个周期重试"); armIdle(); }
    } catch {
      log("vault 自动提交失败，下一个周期重试");
      armIdle();
    }
  }
  function notify(path: string) {
    if (stopped) return;
    // 自动保存覆盖 vault 中所有非隐藏文件（报告、附件、README 等）；补全只处理笔记。
    // 隐藏路径（.obsidian、.git、iCloud 占位文件、我们的临时文件）不重新计时。
    if (!changesAutosave(path)) return;
    lastChange = clock.now();
    armIdle();
    if (!isVaultNotePath(path)) return;
    const timer = debounce.get(path);
    if (timer !== undefined) clock.clear(timer);
    debounce.set(path, clock.set(() => {
      debounce.delete(path);
      enqueue(async () => {
        const file = await vaultFileAt(config.vault, path);
        if (file) {
          options.onProcess?.(path);
          const completed = await syncFile(config.vault, path, options.syncOptions);
          if (completed) result(completed);
        }
        // Refresh also on deletion/rename and on conversion to an excluded note.
        await updateIndex(config.vault, { stateDir: config.stateDir });
      });
    }, 2000));
  }
  try {
    await syncVault(config.vault, { ...options.syncOptions, onResult: result });
    await updateIndex(config.vault, { stateDir: config.stateDir });
    lastFullSync = new Date(clock.now()).toISOString();
    watcher = (options.watch ?? watch)(config.vault, { recursive: true }, (_event, name) => {
      if (name !== null) notify(name.toString());
    });
    watcher.on("error", () => { watching = false; report("", "跳过  vault  文件监听失败"); });
    watching = true;
    armIdle();
  } catch (cause) { watcher?.close(); throw cause; }

  return {
    // Serialize operation commits with autosave and metadata completion.
    exclusive<T>(action: () => Promise<T>): Promise<T> {
      const result = queue.then(action);
      queue = result.then(() => {}, () => {});
      return result;
    },
    notify,
    async drain() { await queue; },
    async status(includePrivate = false): Promise<HubStatus> {
      let pending: string[] = [];
      if (git) {
        try { pending = await git.changedFiles(); }
        catch { log("无法查询 vault 待提交文件"); }
      }
      return { watching, last_full_sync: lastFullSync,
        pending_files: pending.filter((path) => includePrivate || !privatePath(path)).length,
        issues: issues.filter((issue) => includePrivate || !privatePath(issue.path)).map((issue) => issue.line) };
    },
    async stop() {
      stopped = true; watching = false; watcher?.close();
      if (idleTimer !== undefined) clock.clear(idleTimer);
      for (const timer of debounce.values()) clock.clear(timer);
      debounce.clear();
      await queue;
    },
  };
}
