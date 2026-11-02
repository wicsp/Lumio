import { isolatedHome } from "./test-home.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@lumio/knowledge";
import { writeFileAtomic } from "@lumio/storage";
import { Idea, Paper } from "@lumio/schema";
import { syncVault } from "../src/sync.ts";
const cliHome = isolatedHome();

const fixture = fileURLToPath(new URL("../../../fixtures/sync-vault", import.meta.url));
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
let temp: string;
let vault: string;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-sync-test-"));
  vault = join(temp, "vault");
  await cp(fixture, vault, { recursive: true });
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

async function run(args: string[], envVault?: string) {
  const proc = Bun.spawn([process.execPath, main, ...args], {
    cwd: temp, env: { ...process.env, HOME: cliHome, LUMIO_VAULT: envVault, TZ: "Asia/Singapore" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function snapshot(root = vault): Promise<Record<string, { bytes: Buffer; mtime: number; ino: number }>> {
  const result: Record<string, { bytes: Buffer; mtime: number; ino: number }> = {};
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        result[path.slice(root.length)] = { bytes: await readFile(path), mtime: info.mtimeMs, ino: info.ino };
      }
    }
  }
  await walk(root);
  return result;
}

test("sync uses synthetic fixtures, prints one line per changed/problem file and a summary; preserves bodies and links", async () => {
  const before = await snapshot();
  const result = await run(["sync", "--vault", vault]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("完成：扫描 5 个，补全 3 个，问题 1 个，跳过 1 个");
  expect(result.stdout).toContain("补全  research/ideas/新的想法.md  +id +type +title +created +updated");
  expect(result.stdout).toContain("补全  research/ideas/缺少ID.md  +id");
  expect(result.stdout).toContain("问题  library/papers/Foo.md  +id +type +created +updated citekey: 缺失，且文件名不是合法 citekey");
  expect(result.stdout).toContain("跳过  research/ideas/坏文件.md  frontmatter 不是合法 YAML");
  expect(result.stdout.trim().split("\n")).toHaveLength(5);
  const after = await snapshot();
  const changed = ["/research/ideas/新的想法.md", "/research/ideas/缺少ID.md", "/library/papers/Foo.md"];
  for (const [path, previous] of Object.entries(before)) {
    const current = after[path]!;
    if (!changed.includes(path)) expect(current).toEqual(previous);
    else {
      const original = parseFrontmatter(previous.bytes);
      const parsed = parseFrontmatter(current.bytes);
      expect(parsed.body).toEqual(original.body);
      expect(parsed.data).toMatchObject(original.data);
      expect(parsed.data.created).toMatch(/T\d\d:\d\d:\d\d\+08:00$/);
      expect(parsed.data.updated).toMatch(/T\d\d:\d\d:\d\d\+08:00$/);
      if (path.startsWith("/research/ideas/")) expect(Idea.safeParse(parsed.data).success).toBe(true);
      if (path === "/library/papers/Foo.md") expect(Paper.safeParse(parsed.data).success).toBe(false);
    }
  }
  expect(Paper.safeParse(parseFrontmatter(after["/library/papers/He_2020_LightGCN.md"]!.bytes).data).success).toBe(true);
});

test("second sync fills zero and writes no files, even with unresolved issues and invalid YAML", async () => {
  await run(["sync", "--vault", vault]);
  const before = await snapshot();
  const result = await run(["sync", "--vault", vault]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("完成：扫描 5 个，补全 0 个，问题 1 个，跳过 1 个");
  expect(await snapshot()).toEqual(before);
});

test("dry-run reports changes but preserves every file's bytes, mtime and inode", async () => {
  const before = await snapshot();
  const result = await run(["sync", "--dry-run", "--vault", vault]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("完成：扫描 5 个，补全 3 个，问题 1 个，跳过 1 个");
  expect(await snapshot()).toEqual(before);
});

test("LUMIO_VAULT is used, explicit --vault wins, missing vault explains setup", async () => {
  const before = await snapshot();
  expect((await run(["sync", "--dry-run"], vault)).stdout).toContain("扫描 5 个");
  const empty = join(temp, "empty");
  await mkdir(empty);
  const explicit = await run(["sync", "--vault", empty], vault);
  expect(explicit.code).toBe(0);
  expect(explicit.stdout).toBe("完成：扫描 0 个，补全 0 个，问题 0 个，跳过 0 个\n");
  const missing = await run(["sync"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("lumio-hub setup");
  expect(missing.stderr).toContain("install.sh");
  expect(await snapshot()).toEqual(before);
});

test("clean vault exits zero, nested notes are completed, all five entity directories are handled", async () => {
  await rm(join(vault, "library/papers/Foo.md"));
  await rm(join(vault, "research/ideas/坏文件.md"));
  await mkdir(join(vault, "research/ideas/sub"));
  await cp(join(fixture, "research/ideas/新的想法.md"), join(vault, "research/ideas/sub/nested.md"));
  for (const dir of ["plan/projects", "plan/tasks", "research/experiments"]) {
    await mkdir(join(vault, dir), { recursive: true });
    // Experiment's project is required and cannot be inferred by the completer.
    const source = dir === "research/experiments" ? "---\nproject: prj_01J9Z3K8M2N4P6Q8R0S2T4V6W8\n---\nbody" : "body";
    await writeFile(join(vault, dir, "synthetic.md"), source);
  }
  const result = await run(["sync", "--vault", vault]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("完成：扫描 7 个，补全 6 个，问题 0 个，跳过 0 个");
  expect(result.stdout).toContain("research/ideas/sub/nested.md");
  const before = await snapshot();
  expect((await run(["sync", "--vault", vault])).stdout).toBe("完成：扫描 7 个，补全 0 个，问题 0 个，跳过 0 个\n");
  expect(await snapshot()).toEqual(before);
});

test("symlinks are not followed into files or directories outside the synthetic vault", async () => {
  const outside = join(temp, "outside");
  await cp(join(fixture, "research/ideas"), outside, { recursive: true });
  const before = await snapshot(outside);
  await symlink(outside, join(vault, "research/ideas/linked"));
  await symlink(join(outside, "新的想法.md"), join(vault, "research/ideas/linked.md"));
  await mkdir(join(vault, "plan"));
  await symlink(outside, join(vault, "plan/projects"));
  const result = await run(["sync", "--vault", vault]);
  expect(result.stdout).toContain("扫描 5 个");
  expect(result.stdout).not.toContain("linked");
  expect(await snapshot(outside)).toEqual(before);
  expect((await lstat(join(vault, "research/ideas/linked.md"))).isSymbolicLink()).toBe(true);
});

test.each([["new", "idea"], ["sync", "extra"], ["sync", "--unknown"], ["sync", "--vault"]])("bad CLI arguments fail: %s %s", async (first, second) => {
  const result = await run([first, second]);
  expect(result.code).toBe(1);
  expect(result.stderr.length).toBeGreaterThan(0);
});

test("missing vault directory fails without reporting success", async () => {
  const result = await run(["sync", "--vault", join(temp, "absent")]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("无法扫描 vault");
  expect(result.stdout).toBe("");
});

test("sync fills every null metadata field in place, validates the notes and remains idempotent", async () => {
  const nullVault = join(temp, "null-vault");
  await cp(fileURLToPath(new URL("../../../fixtures/sync-null-vault", import.meta.url)), nullVault, { recursive: true });
  const before = await snapshot(nullVault);
  const result = await run(["sync", "--vault", nullVault]);
  expect(result).toEqual({ code: 0, stderr: "", stdout: expect.stringContaining("扫描 2 个，补全 2 个，问题 0 个，跳过 0 个") });
  const after = await snapshot(nullVault);
  for (const [path, original] of Object.entries(before)) {
    const old = parseFrontmatter(original.bytes);
    const parsed = parseFrontmatter(after[path]!.bytes);
    expect(Object.keys(parsed.data)).toEqual(Object.keys(old.data));
    expect(parsed.body).toEqual(old.body);
    expect((path.startsWith("/research/ideas/") ? Idea : Paper).safeParse(parsed.data).success).toBe(true);
  }
  expect(parseFrontmatter(after["/research/ideas/空元数据.md"]!.bytes).data).toMatchObject({ tags: null, related: null });
  expect(parseFrontmatter(after["/library/papers/He_2020_LightGCN.md"]!.bytes).data.citekey).toBe("He_2020_LightGCN");
  expect((await run(["sync", "--vault", nullVault])).stdout).toContain("补全 0 个");
  expect(await snapshot(nullVault)).toEqual(after);
});

test("sync skips a file changed during processing and preserves the human edit", async () => {
  const path = join(vault, "research/ideas/新的想法.md");
  const original = await readFile(path);
  const edited = Buffer.concat([original, Buffer.from("\n人工并发追加的正文 [[链接]]\n")]);
  const output: string[] = [];
  let guarded = false;
  const code = await syncVault(vault, {
    log: (line) => output.push(line),
    writeFile: (target, content, options) => {
      if (target !== path) return writeFileAtomic(target, content, options);
      expect(options?.expectedContent).toEqual(original);
      guarded = true;
      return writeFileAtomic(target, content, { ...options, beforeCommit: () => writeFile(path, edited) });
    },
  });
  expect(guarded).toBe(true);
  expect(code).toBe(1);
  expect(output).toContain("跳过  research/ideas/新的想法.md  文件在处理中被修改，请重新运行");
  expect(output.at(-1)).toBe("完成：扫描 5 个，补全 2 个，问题 1 个，跳过 2 个");
  expect(await readFile(path)).toEqual(edited);
  expect((await readdir(join(vault, "research/ideas"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
