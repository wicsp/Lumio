import { isolatedHome } from "./test-home.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@lumio/knowledge";
import { Idea } from "@lumio/schema";
import cases from "../../../fixtures/new-idea/cases.json";
const cliHome = isolatedHome();

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
let vault: string;
beforeEach(async () => { vault = await mkdtemp(join(tmpdir(), "lumio-cli-idea-test-")); });
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, main, ...args], {
    env: { ...process.env, HOME: cliHome, LUMIO_VAULT: vault, TZ: "Asia/Singapore" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test.each([cases.chinese, cases.unicode, cases.illegal])("new idea writes a valid note; sync fills zero for %s", async (title) => {
  const filename = title === cases.illegal ? cases.illegalFilename : title;
  const path = join(vault, "research/ideas", `${filename}.md`);
  const created = await run(["new", "idea", title, "--vault", vault]);
  expect(created).toEqual({ stdout: `research/ideas/${filename}.md\n`, stderr: "", code: 0 });
  const bytes = await readFile(path);
  expect(Idea.safeParse(parseFrontmatter(bytes).data).success).toBe(true);
  expect(parseFrontmatter(bytes).data.title).toBe(title);
  const before = await stat(path);
  expect(await run(["sync"])).toEqual({ stdout: "完成：扫描 1 个，补全 0 个，问题 0 个，跳过 0 个\n", stderr: "", code: 0 });
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect((await stat(path)).ino).toBe(before.ino);
  const duplicate = await run(["new", "idea", title]);
  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toContain(path);
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
});

test.each(cases.empty)("empty title fails without writing: %j", async (title) => {
  const result = await run(["new", "idea", title]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("标题不能为空");
  expect(await readdir(vault)).toEqual([]);
});

test("new idea does not accept dry-run", async () => {
  const result = await run(["new", "idea", cases.chinese, "--dry-run"]);
  expect(result.code).toBe(1);
  expect(await readdir(vault)).toEqual([]);
});
