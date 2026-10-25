import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseFrontmatter, writeFileAtomic } from "@lumio/core";
import { Idea, Timestamp } from "@lumio/schema";
import { startVaultWatch, type WatchClock, type WatchOptions } from "../src/watch.ts";

class Clock implements WatchClock {
  time = Date.parse("2026-10-25T00:00:00Z");
  sequence = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  set = (callback: () => void, delay: number) => {
    const id = ++this.sequence; this.timers.set(id, { at: this.time + delay, callback }); return id;
  };
  clear = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number) {
    this.time += ms;
    const due = [...this.timers].filter(([, timer]) => timer.at <= this.time);
    for (const [id, timer] of due) { if (this.timers.delete(id)) timer.callback(); }
  }
}
let temp: string, vault: string, stateDir: string, clock: Clock, logs: string[];
let service: Awaited<ReturnType<typeof startVaultWatch>> | undefined;
const fixture = new URL("../../../fixtures/sync-vault/research/ideas/新的想法.md", import.meta.url);
const cardFixture = new URL("../../../fixtures/query-vault/research/ideas/Card.md", import.meta.url);
const plainWatch = (() => Object.assign(new EventEmitter(), { close() {} }) as FSWatcher) as typeof watch;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-watch-")); vault = join(temp, "vault"); stateDir = join(temp, "state");
  await mkdir(join(vault, "research/ideas"), { recursive: true }); clock = new Clock(); logs = [];
});
afterEach(async () => { await service?.stop(); service = undefined; await rm(temp, { recursive: true, force: true }); });
function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", vault, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
function initGit() {
  git("init", `--separate-git-dir=${join(temp, "gitdir")}`);
  git("config", "user.name", "Synthetic Test"); git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-m", "fixture");
}
async function start(options: WatchOptions = {}) {
  service = await startVaultWatch({ vault, stateDir, autosaveIdle: 10 }, {
    clock, watch: plainWatch, log: (line) => logs.push(line), ...options,
  });
  return service;
}
async function tick(ms: number) { clock.advance(ms); await service!.drain(); }
function indexedPaths() {
  const db = new Database(join(stateDir, "index.sqlite"), { readonly: true });
  try { return db.query<{ path: string }, []>("SELECT path FROM notes ORDER BY path").all().map((row) => row.path); }
  finally { db.close(); }
}

test("startup fills offline notes and updates the index before watching", async () => {
  const path = join(vault, "research/ideas/offline.md"); await cp(fixture, path);
  const hub = await start();
  Idea.parse(parseFrontmatter(await readFile(path)).data);
  expect(indexedPaths()).toEqual(["research/ideas/offline.md"]);
  const status = await hub.status(); expect(status.watching).toBe(true); Timestamp.parse(status.last_full_sync);
  expect(status.last_full_sync).toBe(new Date(clock.now()).toISOString());
});

test("five rapid edits debounce once, and a self-write event processes without a second write", async () => {
  let processed = 0, written = 0;
  const hub = await start({ onProcess: () => { processed++; }, syncOptions: {
    writeFile: async (...args) => { const result = await writeFileAtomic(...args); written += Number(result); return result; },
  } });
  const relative = "research/ideas/x.md", path = join(vault, relative);
  for (let i = 0; i < 5; i++) {
    await cp(fixture, path); hub.notify(relative); await tick(100);
  }
  await tick(1899); expect(processed).toBe(0);
  await tick(1); expect(processed).toBe(1); expect(written).toBe(1);
  Idea.parse(parseFrontmatter(await readFile(path)).data);
  expect(indexedPaths()).toEqual([relative]);
  const before = await stat(path);
  hub.notify(relative); await tick(2000);
  expect(processed).toBe(2); expect(written).toBe(1);
  expect((await stat(path)).ino).toBe(before.ino);
  await tick(100_000); expect(processed).toBe(2);
});

test("hidden paths, placeholders, temporary files, Excalidraw, outside paths and symlinks do not process", async () => {
  const processed: string[] = [];
  const hub = await start({ onProcess: (path) => processed.push(path) });
  const paths = ["research/ideas/.hidden.md", "research/ideas/.hidden/x.md", "research/ideas/x.md.icloud",
    "research/ideas/.x.md.uuid.tmp", "research/ideas/drawing.excalidraw.md", "files/x.md", "research/reports/x.md"];
  for (const path of paths) {
    await mkdir(join(vault, path, ".."), { recursive: true }); await cp(fixture, join(vault, path)); hub.notify(path);
  }
  const drawing = "research/ideas/drawing.md";
  await cp(new URL("../../../fixtures/layout-vault/create/posts/嵌入的画板.md", import.meta.url), join(vault, drawing)); hub.notify(drawing);
  await cp(fixture, join(temp, "outside.md"));
  await symlink(join(temp, "outside.md"), join(vault, "research/ideas/link.md")); hub.notify("research/ideas/link.md");
  await symlink(temp, join(vault, "research/ideas/linkdir")); hub.notify("research/ideas/linkdir/outside.md");
  hub.notify("../outside.md"); hub.notify(join(temp, "outside.md"));
  await tick(2000);
  expect(processed).toEqual([]); expect(indexedPaths()).toEqual([]);
  expect(await readFile(join(temp, "outside.md"))).toEqual(await readFile(fixture));
});

test("FILE_CHANGED preserves the human edit, is silent and waits for another event", async () => {
  let conflict = true, processed = 0;
  const body = await readFile(fixture);
  const hub = await start({ onProcess: () => { processed++; }, syncOptions: {
    writeFile: (path, content, options) => writeFileAtomic(path, content, { ...options, beforeCommit: async () => {
      if (conflict) { conflict = false; await writeFile(path, Buffer.concat([body, body])); }
    } }),
  } });
  const relative = "research/ideas/conflict.md", path = join(vault, relative);
  await cp(fixture, path); hub.notify(relative); await tick(2000);
  expect(await readFile(path)).toEqual(Buffer.concat([body, body]));
  expect((await hub.status()).issues).toEqual([]); expect(logs.join("\n")).not.toContain("FILE_CHANGED");
  await tick(10_000); expect(processed).toBe(1);
  hub.notify(relative); await tick(2000);
  Idea.parse(parseFrontmatter(await readFile(path)).data); expect(processed).toBe(2);
});

test("idle timer resets on changes, commits once and omits actor trailers", async () => {
  initGit(); const hub = await start();
  const relative = "research/ideas/x.md"; await cp(fixture, join(vault, relative)); hub.notify(relative);
  await tick(2000); await tick(7000); expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
  hub.notify(relative); await tick(9999); expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
  await tick(1); expect(git("rev-list", "--count", "HEAD").trim()).toBe("2");
  expect(git("log", "-1", "--format=%B").trim()).toBe("lumio: auto-save 1 files");
  await tick(30_000); expect(git("rev-list", "--count", "HEAD").trim()).toBe("2");
  expect((await hub.status()).pending_files).toBe(0);
});

test("non-note files (reports, attachments) also start the idle timer and get committed; hidden paths do not", async () => {
  initGit(); const hub = await start();
  await tick(10_000); const base = Number(git("rev-list", "--count", "HEAD").trim());
  await mkdir(join(vault, "research/reports"), { recursive: true });
  await writeFile(join(vault, "research/reports/开题报告.md"), "# 开题报告\n");
  hub.notify("research/reports/开题报告.md");
  await tick(10_000);
  expect(Number(git("rev-list", "--count", "HEAD").trim())).toBe(base + 1);
  expect(git("-c", "core.quotepath=false", "show", "--name-only", "--format=", "HEAD").trim()).toBe("research/reports/开题报告.md");
  // 只有隐藏路径变化时不重新计时、不提交。
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  hub.notify(".obsidian/workspace.json");
  await tick(60_000);
  expect(Number(git("rev-list", "--count", "HEAD").trim())).toBe(base + 1);
});

test("all pending files are card-checked, including pre-staged non-notes; safe files still commit", async () => {
  initGit(); const hub = await start();
  const safe = "research/ideas/safe.md", blocked = "research/ideas/card.md", other = "files/card.txt";
  await cp(fixture, join(vault, safe)); await cp(cardFixture, join(vault, blocked));
  await mkdir(join(vault, "files")); await cp(cardFixture, join(vault, other));
  git("add", other);
  hub.notify(safe); hub.notify(blocked); await tick(2000); await tick(8000);
  expect(git("show", "--format=", "--name-only", "HEAD").trim()).toBe(safe);
  const status = await hub.status(); expect(status.pending_files).toBe(2);
  expect(status.issues).toContain(blocked); expect(status.issues).toContain(other);
  expect(indexedPaths()).toEqual([safe]);
  const raw = await readFile(cardFixture, "utf8"); const number = raw.match(/\d{16}/)![0];
  expect(logs.join("\n") + JSON.stringify(status)).not.toContain(number);
});

test("commit lock failures log once and retry in the next idle cycle", async () => {
  initGit(); const hub = await start(); const relative = "research/ideas/x.md";
  await cp(fixture, join(vault, relative)); hub.notify(relative); await tick(2000);
  await writeFile(join(temp, "gitdir/HEAD.lock"), "synthetic lock"); await tick(8000);
  expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
  expect(logs.join("\n")).toContain("自动提交失败");
  await rm(join(temp, "gitdir/HEAD.lock")); await tick(10_000);
  expect(git("rev-list", "--count", "HEAD").trim()).toBe("2");
});

test("git unavailable logs only on startup and does not stop sync or status", async () => {
  const hub = await start(); const relative = "research/ideas/x.md";
  await cp(fixture, join(vault, relative)); hub.notify(relative); await tick(2000); await tick(30_000);
  expect(logs).toEqual(["vault git 不可用，跳过自动提交"]);
  expect((await hub.status()).pending_files).toBe(0); expect(indexedPaths()).toEqual([relative]);
});

test("deletions refresh the index and are committed", async () => {
  initGit(); const relative = "research/ideas/x.md", path = join(vault, relative); await cp(fixture, path);
  const hub = await start(); await tick(10_000); expect(indexedPaths()).toEqual([relative]);
  await rm(path); hub.notify(relative); await tick(2000); expect(indexedPaths()).toEqual([]);
  await tick(8000); expect((await hub.status()).pending_files).toBe(0);
  expect(git("log", "-1", "--format=%B").trim()).toBe("lumio: auto-save 1 files");
});

test("latest twenty issues are bounded, private paths require explicit opt-in, watcher errors change status", async () => {
  const emitter = Object.assign(new EventEmitter(), { close() {} }) as FSWatcher;
  const hub = await start({ watch: (() => emitter) as typeof watch });
  const bad = new URL("../../../fixtures/sync-vault/research/ideas/坏文件.md", import.meta.url);
  for (let i = 0; i < 22; i++) {
    const relative = `research/ideas/bad-${i}.md`; await cp(bad, join(vault, relative)); hub.notify(relative);
  }
  await tick(2000); expect((await hub.status()).issues).toHaveLength(20);
  expect((await hub.status()).issues.join("\n")).not.toContain("bad-0.md");
  await mkdir(join(vault, "life/assets"), { recursive: true }); await cp(bad, join(vault, "life/assets/bad.md"));
  hub.notify("life/assets/bad.md"); await tick(2000);
  expect((await hub.status()).issues.join("\n")).not.toContain("life/assets");
  expect((await hub.status(true)).issues.join("\n")).toContain("life/assets/bad.md");
  emitter.emit("error", new Error("synthetic error")); expect((await hub.status()).watching).toBe(false);
});

test("real recursive fs.watch completes a new note in seconds and its own write settles", async () => {
  let written = 0, processed = 0;
  const hub = await start({ clock: undefined, watch, onProcess: () => { processed++; }, syncOptions: {
    writeFile: async (...args) => { const changed = await writeFileAtomic(...args); written += Number(changed); return changed; },
  } });
  // Linux 的递归监听在启动后要一点时间才挂到各个子目录上；这段空档由启动时的全量补全覆盖（不是这个用例要测的）。
  await Bun.sleep(500);
  const path = join(vault, "research/ideas/x.md"); await cp(fixture, path);
  // 要保证的是"补全只写一次、不循环"。Hub 自己写回后是否还会收到一次事件、何时收到，取决于系统和负载，
  // 不作为断言条件（原来要求恰好处理两次，机器繁忙时会偶发失败）。
  const deadline = Date.now() + 6500;
  while (written < 1 && Date.now() < deadline) await Bun.sleep(50);
  await Bun.sleep(3000); // 防抖 2 秒 + 余量，让写回引起的事件（如果有）处理完
  await hub.drain();
  Idea.parse(parseFrontmatter(await readFile(path)).data);
  expect(written).toBe(1);
  expect(processed).toBeGreaterThanOrEqual(1); expect(processed).toBeLessThanOrEqual(2);
  expect(indexedPaths()).toEqual(["research/ideas/x.md"]);
}, 15000);

test("index.lock staging failures also retry automatically in the next cycle", async () => {
  initGit(); const hub = await start(); const relative = "research/ideas/x.md";
  await cp(fixture, join(vault, relative)); hub.notify(relative); await tick(2000);
  await writeFile(join(temp, "gitdir/index.lock"), "synthetic lock"); await tick(8000);
  expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
  expect(logs.join("\n")).toContain("自动提交失败");
  await rm(join(temp, "gitdir/index.lock")); await tick(10_000);
  expect(git("rev-list", "--count", "HEAD").trim()).toBe("2");
});
