import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLogEvent, StoredArtifact, BackupManifest } from "@lumio/schema";
import { RunLogWriter, readRunLog, parseLogSegment } from "../src/logs.ts";
import { SqliteArtifacts } from "../src/artifacts.ts";
import { backupBusiness, restoreBusiness, verifyBusinessBackup } from "../src/backup.ts";
import { acquireStateLease } from "../src/lease.ts";

const run = "job_00000000000000000000000001", id = "art_00000000000000000000000001";
const bytes = Buffer.from("原始输出\n不是控制状态\n");
const artifact = (fields: object = {}) => StoredArtifact.parse({ id, owner: { module: "execution", id: run }, key: `${id}.bin`,
  sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, media_type: "text/plain", status: "staged", private: false, created: "2026-11-01T00:00:00Z", ...fields });
async function* chunks(value: Uint8Array) { for (let i = 0; i < value.length; i += 3) yield value.subarray(i, i + 3); }
async function temporary(action: (root: string) => Promise<void>) { const root = await mkdtemp(join(tmpdir(), "lumio-storage-files-")); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }

test("a state lease excludes a second business writer and releases without stale-file deletion", async () => temporary(async (root) => {
  const first = await acquireStateLease(root);
  await expect(acquireStateLease(root)).rejects.toMatchObject({ code: "CONFLICT" });
  first.close(); first.close();
  const next = await acquireStateLease(root); next.close();
  expect(await Bun.file(join(root, ".business-writer.sqlite")).exists()).toBe(true);
}));

test("a JSONL run has one writer, serializes concurrent calls, rotates segments and seals complete schema-valid Unicode events", async () => temporary(async (root) => {
  const writer = await RunLogWriter.create(root, run, { segmentBytes: 300 });
  await expect(RunLogWriter.create(root, run)).rejects.toMatchObject({ code: "CONFLICT" });
  const events = await Promise.all(Array.from({ length: 5 }, (_, index) => writer.append("output", { stream: "stdout", text: `中文 ${index}` })));
  await writer.close(); await writer.close();
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  expect((await readdir(join(root, run))).length).toBeGreaterThan(1);
  const parsed = await readRunLog(root, run); expect(parsed).toEqual({ events, incomplete: false, active: false });
  expect(events.every((event) => RunLogEvent.safeParse(event).success)).toBe(true);
  await expect(writer.append("late", {})).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(RunLogWriter.create(root, "../escape")).rejects.toMatchObject({ code: "INVALID" });
}));

test("JSONL distinguishes active UTF-8 tail truncation from archived truncation, corrupt middle records and missing or duplicate sequence", () => {
  const event = RunLogEvent.parse({ schema_version: 1, id: "evt_00000000000000000000000001", run, sequence: 1, time: "2026-11-01T00:00:00Z", type: "status", payload: { status: "running" } });
  const line = JSON.stringify(event) + "\n", partial = Buffer.concat([Buffer.from(line), Buffer.from([0x7b, 0xe4, 0xb8])]);
  expect(parseLogSegment(partial, { run, active: true })).toMatchObject({ events: [event], next: 2, incomplete: true });
  expect(() => parseLogSegment(partial, { run, active: false })).toThrow("末行");
  expect(() => parseLogSegment(Buffer.from(line + "{bad}\n"), { run, active: true })).toThrow("中间");
  expect(() => parseLogSegment(Buffer.from(line + line), { run, active: false })).toThrow("顺序");
  expect(() => parseLogSegment(Buffer.from(line.replace('"sequence":1', '"sequence":2')), { run, active: false })).toThrow("顺序");
  expect(() => parseLogSegment(Buffer.from([0xff, 10]), { run, active: true })).toThrow("UTF-8");
});

test("artifact registration and byte confirmation are distinct; bad uploads stay staged, retries deduplicate and crash recovery validates published bytes", async () => temporary(async (root) => {
  const db = new Database(":memory:");
  try {
    const files = new SqliteArtifacts(db, root), staged = files.stage(artifact());
    expect(files.stage(artifact())).toEqual(staged);
    await expect(files.path(id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(files.publish(id, chunks(bytes.subarray(0, 2)))).rejects.toMatchObject({ code: "INVALID" });
    await expect(files.publish(id, chunks(Buffer.alloc(bytes.length, 1)))).rejects.toMatchObject({ code: "INVALID" });
    expect(files.get(id).status).toBe("staged"); expect(await files.recover()).toEqual({ recovered: [], missing: [id] });
    db.exec("CREATE TRIGGER fail_ready BEFORE UPDATE ON storage_artifacts BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    await expect(files.publish(id, chunks(bytes))).rejects.toThrow("injected failure");
    expect(files.get(id).status).toBe("staged"); expect(await readFile(join(root, `${id}.bin`))).toEqual(bytes);
    db.exec("DROP TRIGGER fail_ready");
    expect(await files.recover()).toEqual({ recovered: [id], missing: [] });
    expect((await files.publish(id, chunks(bytes))).status).toBe("ready");
    expect(files.stage(artifact()).status).toBe("ready"); expect(files.list()).toHaveLength(1);
    expect(() => files.stage(artifact({ size: bytes.length + 1 }))).toThrow("不同");
    expect(() => files.stage({ ...artifact(), key: "../escape" })).toThrow("格式");
    await writeFile(await files.path(id), "tampered"); await expect(files.path(id)).rejects.toMatchObject({ code: "CORRUPT" });
  } finally { db.close(); }
}));

test("business backup captures live WAL data and referenced files, verifies and restores to a new directory without replacing existing data", async () => temporary(async (root) => {
  const state = join(root, "state"), backup = join(root, "backup"), restored = join(root, "restored"); await mkdir(state);
  const db = new Database(join(state, "hub.sqlite")); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE test_work(id TEXT PRIMARY KEY, description TEXT)");
  try {
    const files = new SqliteArtifacts(db, join(state, "files")); files.stage(artifact()); await files.publish(id, chunks(bytes));
    db.query("INSERT INTO test_work VALUES(?,?)").run("synthetic", "已提交但仍在 WAL 的正文");
    const manifest = await backupBusiness(state, backup);
    expect(BackupManifest.safeParse(manifest).success).toBe(true); expect(manifest.files).toHaveLength(1);
    expect(await verifyBusinessBackup(backup)).toEqual(manifest);
    expect(await restoreBusiness(backup, restored)).toEqual(manifest);
    const copy = new Database(join(restored, "hub.sqlite"), { readonly: true });
    try { expect(copy.query("SELECT description FROM test_work").get()).toEqual({ description: "已提交但仍在 WAL 的正文" });
      expect(await readFile(join(restored, "files", `${id}.bin`))).toEqual(bytes);
    } finally { copy.close(); }
    await expect(restoreBusiness(backup, state)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.query("SELECT * FROM test_work").all()).toHaveLength(1);
    await expect(backupBusiness(state, backup)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await verifyBusinessBackup(backup)).toEqual(manifest);
    for (const mode of ["missing", "tampered", "duplicate", "symlink"]) {
      const damaged = join(root, mode); await cp(backup, damaged, { recursive: true });
      const file = join(damaged, manifest.files[0]!.path);
      if (mode === "missing") await rm(file);
      if (mode === "tampered") await writeFile(file, "changed");
      if (mode === "symlink") { await rm(file); await symlink(join(state, "files", `${id}.bin`), file); }
      if (mode === "duplicate") await writeFile(join(damaged, "manifest.json"), JSON.stringify({ ...manifest, files: [...manifest.files, manifest.files[0]] }));
      await expect(restoreBusiness(damaged, join(root, `${mode}-restore`))).rejects.toMatchObject({ code: "CORRUPT" });
      expect(await Bun.file(join(root, `${mode}-restore`, "hub.sqlite")).exists()).toBe(false);
    }
    await rm(join(state, "files", `${id}.bin`));
    await expect(backupBusiness(state, join(root, "incomplete"))).rejects.toThrow();
    expect(await Bun.file(join(root, "incomplete/manifest.json")).exists()).toBe(false);
  } finally { db.close(); }
}));
