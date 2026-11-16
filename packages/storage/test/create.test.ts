import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Idea } from "@lumio/schema";
import cases from "../../../fixtures/new-idea/cases.json";
import { createIdea } from "../src/index.ts";
import { fillMetadata, parseFrontmatter, renderIdea, type FillContext } from "@lumio/knowledge";

const ctx: FillContext = {
  now: new Date("2026-10-22T22:00:00+08:00"), tz: "Asia/Singapore",
  newId: (prefix) => `${prefix}_01J9Z3K8M2N4P6Q8R0S2T4V6W8`,
};
let vault: string;
beforeEach(async () => { vault = await mkdtemp(join(tmpdir(), "lumio-idea-test-")); });
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

test.each([cases.chinese, cases.unicode, cases.illegal])("new idea preserves original title and passes Idea contract: %s", async (title) => {
  const expectedFile = title === cases.illegal ? cases.illegalFilename : title;
  const path = await createIdea(vault, title, ctx);
  expect(path).toBe(`research/ideas/${expectedFile}.md`);
  const parsed = parseFrontmatter(await readFile(join(vault, path)));
  expect(Idea.safeParse(parsed.data).success).toBe(true);
  expect(parsed.data.title).toBe(title);
  expect(parsed.data.created).toBe("2026-10-22T22:00:00+08:00");
  expect(parsed.data.updated).toBe(parsed.data.created);
  expect(parsed.body.toString()).toBe("\n");
  expect(parsed.data).not.toHaveProperty("status");
  expect(parsed.data).not.toHaveProperty("tags");
  expect(parsed.data).not.toHaveProperty("related");
  expect(fillMetadata({ type: "idea", frontmatter: parsed.data, fileName: expectedFile, birthtime: ctx.now, mtime: ctx.now }, ctx))
    .toEqual({ patch: {}, issues: [] });
});

test("new and sync use exactly the same metadata generator", () => {
  const parsed = parseFrontmatter(renderIdea(cases.chinese, ctx).content);
  const original = { title: cases.chinese };
  const { patch } = fillMetadata({ type: "idea", frontmatter: original, fileName: cases.chinese, birthtime: ctx.now, mtime: ctx.now }, ctx);
  expect(parsed.data).toEqual({ ...original, ...patch });
});

test("same filename is refused without modifying contents, mtime or inode", async () => {
  const path = join(vault, await createIdea(vault, cases.chinese, ctx));
  const before = await stat(path);
  const content = await readFile(path);
  await expect(createIdea(vault, cases.chinese, ctx)).rejects.toMatchObject({ code: "FILE_EXISTS" });
  expect(await readFile(path)).toEqual(content);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect((await stat(path)).ino).toBe(before.ino);
  expect(await readdir(join(vault, "research/ideas"))).toEqual([`${cases.chinese}.md`]);
});

test("concurrent creation publishes one complete file and never overwrites the winner", async () => {
  const results = await Promise.allSettled([createIdea(vault, cases.chinese, ctx), createIdea(vault, cases.chinese, ctx)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({ code: "FILE_EXISTS" });
  const content = await readFile(join(vault, "research/ideas", `${cases.chinese}.md`));
  expect(Idea.safeParse(parseFrontmatter(content).data).success).toBe(true);
  expect(await readdir(join(vault, "research/ideas"))).toHaveLength(1);
});

test.each(cases.empty)("rejects empty title before creating files: %j", async (title) => {
  await expect(createIdea(vault, title, ctx)).rejects.toMatchObject({ code: "EMPTY_TITLE" });
  expect(await readdir(vault)).toEqual([]);
});

test("a title containing only illegal characters cannot produce a filename", async () => {
  await expect(createIdea(vault, cases.unusable, ctx)).rejects.toMatchObject({ code: "INVALID_FILE_NAME" });
  expect(await readdir(vault)).toEqual([]);
});

test("creation does not follow a symlinked ideas directory", async () => {
  const outside = await mkdtemp(join(tmpdir(), "lumio-idea-outside-test-"));
  try {
    await mkdir(join(vault, "research"));
    await symlink(outside, join(vault, "research/ideas"));
    await expect(createIdea(vault, cases.chinese, ctx)).rejects.toMatchObject({ code: "INVALID_NOTE_DIRECTORY" });
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("creation does not follow a symlinked category directory (research/)", async () => {
  const outside = await mkdtemp(join(tmpdir(), "lumio-idea-outside-test-"));
  try {
    await symlink(outside, join(vault, "research"));
    await expect(createIdea(vault, cases.chinese, ctx)).rejects.toMatchObject({ code: "INVALID_NOTE_DIRECTORY" });
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(outside, { recursive: true, force: true }); }
});
