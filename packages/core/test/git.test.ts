import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVaultGit } from "../src/git.ts";

let temp: string, vault: string;
function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", vault, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-git-")); vault = join(temp, "vault");
  await mkdir(vault);
  git("init", `--separate-git-dir=${join(temp, "gitdir")}`);
  git("config", "user.name", "Synthetic Test"); git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-m", "fixture");
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

test("external gitdir, literal Unicode paths, staged changes and deletions are supported", async () => {
  expect(await readFile(join(vault, ".git"), "utf8")).toContain(join(temp, "gitdir"));
  const repo = (await openVaultGit(vault))!;
  const paths = ["中文 空格.md", "-leading.md", "a[1].md", "line\nbreak.md"];
  for (const path of paths) {
    await cp(new URL("../../../fixtures/sync-vault/research/ideas/新的想法.md", import.meta.url), join(vault, path));
    await repo.add(path);
  }
  expect((await repo.changedFiles()).sort()).toEqual(paths.sort());
  await repo.commit(paths, "lumio: auto-save 4 files");
  expect(await repo.changedFiles()).toEqual([]);
  await rm(join(vault, paths[0]!));
  await repo.add(paths[0]!); await repo.commit([paths[0]!], "deletion");
  expect(await repo.changedFiles()).toEqual([]);
  await expect(repo.add("../outside")).rejects.toMatchObject({ code: "GIT_FAILED" });
});

test("commit excludes unrelated previously staged content and reports sanitized failures", async () => {
  const repo = (await openVaultGit(vault))!;
  await writeFile(join(vault, "safe.md"), "synthetic safe");
  await cp(new URL("../../../fixtures/query-vault/research/ideas/Card.md", import.meta.url), join(vault, "blocked.md"));
  git("add", "blocked.md");
  await repo.add("safe.md"); await repo.commit(["safe.md"], "lumio: auto-save 1 files");
  expect(git("show", "--format=", "--name-only", "HEAD").trim()).toBe("safe.md");
  expect(await repo.changedFiles()).toEqual(["blocked.md"]);
  await writeFile(join(temp, "gitdir/index.lock"), "synthetic lock");
  await expect(repo.add("blocked.md")).rejects.toMatchObject({ code: "GIT_FAILED", message: "无法执行 vault git 操作" });
});

test("missing git, absent .git and parent repositories are unavailable", async () => {
  expect(await openVaultGit(vault, join(temp, "absent-git"))).toBeUndefined();
  const nested = join(vault, "nested"); await mkdir(nested);
  expect(await openVaultGit(nested)).toBeUndefined();
  const empty = join(temp, "empty"); await mkdir(empty);
  expect(await openVaultGit(empty)).toBeUndefined();
});

test("checked staged snapshots stay fixed if the working file changes before commit", async () => {
  const repo = (await openVaultGit(vault))!;
  const path = "safe.md", source = await readFile(new URL("../../../fixtures/sync-vault/research/ideas/新的想法.md", import.meta.url));
  await writeFile(join(vault, path), source); await repo.add(path, source);
  await cp(new URL("../../../fixtures/query-vault/research/ideas/Card.md", import.meta.url), join(vault, path));
  await repo.commit([path], "lumio: auto-save 1 files");
  expect(Buffer.from(git("show", `HEAD:${path}`))).toEqual(source);
  expect(await repo.changedFiles()).toEqual([path]);
  await expect(repo.add(path, source)).rejects.toMatchObject({ code: "FILE_CHANGED" });
});

test("an unborn repository can make its first autosave commit", async () => {
  git("update-ref", "-d", "HEAD");
  const repo = (await openVaultGit(vault))!;
  await writeFile(join(vault, "first.md"), "synthetic safe");
  await repo.add("first.md"); await repo.commit(["first.md"], "lumio: auto-save 1 files");
  expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
  expect(await repo.changedFiles()).toEqual([]);
});
