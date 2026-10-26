import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchNotes } from "../src/index.ts";

// Hub 与本地 CLI 是两个进程，可能同时更新同一个 index.sqlite（P1-2 review）。
const fixture = fileURLToPath(new URL("../../../fixtures/query-vault", import.meta.url));
const loop = fileURLToPath(new URL("./helpers/search-loop.ts", import.meta.url));
let temp: string, vault: string, stateDir: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-index-concurrency-"));
  vault = join(temp, "vault"); stateDir = join(temp, "state");
  await cp(fixture, vault, { recursive: true });
});
afterEach(() => rm(temp, { recursive: true, force: true }));

test("index waits for locks instead of failing, and uses WAL", async () => {
  await searchNotes(vault, "index", { stateDir });
  const db = new Database(join(stateDir, "index.sqlite"), { readonly: true });
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  db.close();
});

test("several processes querying and updating one index concurrently all succeed", async () => {
  for (const tag of ["P1", "P2", "P3", "P4"]) await writeFile(join(vault, "research/ideas", `${tag}.md`), `# ${tag}\n`);
  const children = ["P1", "P2", "P3", "P4"].map((tag) => Bun.spawn(["bun", loop, vault, stateDir, tag, "12"], { stdout: "ignore", stderr: "pipe" }));
  const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
  expect(results).toEqual(results.map(() => ({ code: 0, stderr: "" })));
}, 30_000);

test("rebuilding a corrupt index also removes stale WAL files", async () => {
  await searchNotes(vault, "index", { stateDir });
  await writeFile(join(stateDir, "index.sqlite"), "not a database");
  await writeFile(join(stateDir, "index.sqlite-wal"), "stale");
  expect((await searchNotes(vault, "index", { stateDir })).total).toBeGreaterThan(0);
  const wal = Bun.file(join(stateDir, "index.sqlite-wal"));
  expect((await wal.exists()) ? await wal.text() : "").not.toBe("stale");
});

test("switching a fresh index to WAL waits for an existing rollback-journal reader", async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "index.sqlite");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE placeholder (value TEXT)"); db.close();
  const child = Bun.spawn([process.execPath, "-e", `import {Database} from "bun:sqlite";
const db=new Database(process.argv[1]); db.exec("BEGIN; SELECT * FROM placeholder");
console.log("locked"); await Bun.sleep(300); db.exec("ROLLBACK");db.close();`, path], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader(); const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    expect((await searchNotes(vault, "index", { stateDir })).total).toBeGreaterThan(0);
    expect(await child.exited).toBe(0);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
});
