import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../src/index.ts";

let temp: string;
let path: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-write-test-"));
  path = join(temp, "synthetic.md");
  await cp(fileURLToPath(new URL("../../../fixtures/sync-vault/research/ideas/新的想法.md", import.meta.url)), path);
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

test("unchanged bytes leave mtime and inode untouched", async () => {
  await utimes(path, new Date(1000), new Date(1000));
  const before = await stat(path);
  expect(await writeFileAtomic(path, await readFile(path))).toBe(false);
  const after = await stat(path);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.ino).toBe(before.ino);
});

test("atomic replacement uses a new inode, preserves permissions and leaves no temporary file", async () => {
  await chmod(path, 0o640);
  const before = await stat(path);
  expect(await writeFileAtomic(path, Buffer.from("updated synthetic note"))).toBe(true);
  expect(await readFile(path, "utf8")).toBe("updated synthetic note");
  const after = await stat(path);
  expect(after.ino).not.toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o640);
  expect(await readdir(temp)).toEqual(["synthetic.md"]);
});

test("can safely create a file; filesystem failures have a code and leave the destination unchanged", async () => {
  const target = join(temp, "created.md");
  expect(await writeFileAtomic(target, Buffer.from("synthetic"))).toBe(true);
  await expect(writeFileAtomic(join(temp, "missing/file.md"), Buffer.from("synthetic")))
    .rejects.toMatchObject({ code: "WRITE_FAILED" });
  const directory = join(temp, "directory");
  await mkdir(directory);
  await expect(writeFileAtomic(directory, Buffer.from("synthetic"))).rejects.toMatchObject({ code: "WRITE_FAILED" });
  expect((await stat(directory)).isDirectory()).toBe(true);
});

test("a matching original permits the guarded replacement", async () => {
  const original = await readFile(path);
  expect(await writeFileAtomic(path, Buffer.from("completed note"), { expectedContent: original })).toBe(true);
  expect(await readFile(path, "utf8")).toBe("completed note");
});

test("edits after the initial read reject stale input without overwriting the new bytes", async () => {
  const original = await readFile(path);
  await writeFile(path, "human edit before preparation");
  await expect(writeFileAtomic(path, Buffer.from("stale completed note"), { expectedContent: original })).rejects.toMatchObject({ code: "FILE_CHANGED" });
  expect(await readFile(path, "utf8")).toBe("human edit before preparation");
  expect(await readdir(temp)).toEqual(["synthetic.md"]);
});

test("edits immediately before rename are preserved and the temporary file is cleaned up", async () => {
  const original = await readFile(path);
  await expect(writeFileAtomic(path, Buffer.from("stale completed note"), {
    expectedContent: original,
    beforeCommit: () => writeFile(path, "human edit before rename"),
  })).rejects.toMatchObject({ code: "FILE_CHANGED" });
  expect(await readFile(path, "utf8")).toBe("human edit before rename");
  expect(await readdir(temp)).toEqual(["synthetic.md"]);
});

test("deletion while preparing the write is not undone by recreating the file", async () => {
  const original = await readFile(path);
  await expect(writeFileAtomic(path, Buffer.from("stale completed note"), {
    expectedContent: original, beforeCommit: () => rm(path),
  })).rejects.toMatchObject({ code: "FILE_CHANGED" });
  expect(await readdir(temp)).toEqual([]);
});
