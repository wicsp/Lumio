import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAndCommit } from "../src/commit.ts";

// Hub 自己的写入：先把人未提交的修改单独存一次，再写入并带 trailer 提交这一个文件（P2-4）。
let temp: string, vault: string;
function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", vault, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
const path = "plan/tasks/任务.md";
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-hub-commit-")); vault = join(temp, "vault");
  await mkdir(join(vault, "plan/tasks"), { recursive: true });
  git("init", `--separate-git-dir=${join(temp, "gitdir")}`);
  git("config", "user.name", "Synthetic Test"); git("config", "user.email", "test@example.invalid");
  await writeFile(join(vault, path), "原文\n");
  git("add", "-A"); git("commit", "-m", "fixture");
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

test("pending human edits are saved first, then the Hub write is committed alone with trailers", async () => {
  await writeFile(join(vault, path), "原文\n人刚加的一行\n");
  await writeFile(join(vault, "other.md"), "别的文件\n");
  const before = await readFile(join(vault, path));
  const ok = await writeAndCommit(vault, path, before, () => writeFile(join(vault, path), `${before}AI 的结果\n`),
    "lumio: 第 1 轮结果 done\n多余的换行", { "Lumio-Actor": "act_00000000000000000000000001", "Lumio-Job": "job_00000000000000000000000001" });
  expect(ok).toBe(true);
  const log = git("log", "--format=%B%x00", "-3").split("\0").map((m) => m.trim()).filter(Boolean);
  expect(log[0]).toBe("lumio: 第 1 轮结果 done 多余的换行\n\nLumio-Actor: act_00000000000000000000000001\nLumio-Job: job_00000000000000000000000001");
  expect(log[1]).toBe("lumio: auto-save 1 files");
  expect(git("show", "HEAD~1:plan/tasks/任务.md")).toBe("原文\n人刚加的一行\n");
  expect(git("show", "HEAD:plan/tasks/任务.md")).toBe("原文\n人刚加的一行\nAI 的结果\n");
  expect(git("status", "--porcelain", "--untracked-files=all")).toBe("?? other.md\n");
});

test("without git the write still happens; card numbers are never committed", async () => {
  const plain = join(temp, "plain"); await mkdir(plain);
  await writeFile(join(plain, "a.md"), "x\n");
  expect(await writeAndCommit(plain, "a.md", Buffer.from("x\n"), () => writeFile(join(plain, "a.md"), "y\n"), "m", {})).toBe(true);
  expect(await readFile(join(plain, "a.md"), "utf8")).toBe("y\n");

  const before = await readFile(join(vault, path));
  const ok = await writeAndCommit(vault, path, before, () => writeFile(join(vault, path), "卡号 4111 1111 1111 1111\n"), "m", {});
  expect(ok).toBe(false);
  expect(git("log", "--format=%s")).toBe("fixture\n");
});
