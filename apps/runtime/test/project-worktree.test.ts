import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobWorktree } from "@lumio/schema";
import { prepareProjectWorktree } from "../src/project-worktree.ts";

test("managed worktrees isolate committed baselines and reopen the same branch with uncommitted work", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "lumio-project-worktree-"));
  const repository = join(root, "repository"), state = join(root, "runtime");
  const env = { HOME: root, PATH: process.env.PATH, GIT_EDITOR: "false" };
  const command = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    await mkdir(repository); await mkdir(state);
    command(repository, "init", "-b", "main");
    await writeFile(join(repository, "fixture.txt"), "initial");
    command(repository, "add", "fixture.txt");
    command(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture: initial");
    const first = JobWorktree.parse({ project: "prj_00000000000000000000000001", task: "task_00000000000000000000000001", base: "main" });
    const second = JobWorktree.parse({ ...first, task: "task_00000000000000000000000002" });
    await writeFile(join(repository, "fixture.txt"), "uncommitted in original");
    const left = await prepareProjectWorktree(state, repository, first, env);
    const right = await prepareProjectWorktree(state, repository, second, env);
    expect(left.path).not.toBe(right.path);
    expect(left.branch).not.toBe(right.branch);
    expect(command(left.path, "branch", "--show-current")).toBe(left.branch);
    expect(command(right.path, "branch", "--show-current")).toBe(right.branch);
    expect(await readFile(join(left.path, "fixture.txt"), "utf8")).toBe("initial");
    expect(await readFile(join(right.path, "fixture.txt"), "utf8")).toBe("initial");
    expect(await readFile(join(repository, "fixture.txt"), "utf8")).toBe("uncommitted in original");
    await writeFile(join(left.path, "fixture.txt"), "work in progress");
    const reopened = await prepareProjectWorktree(state, repository, { ...first, reuse: true }, env);
    expect(reopened).toEqual(left);
    expect(await readFile(join(reopened.path, "fixture.txt"), "utf8")).toBe("work in progress");
    await expect(prepareProjectWorktree(state, repository, { ...first, base: "HEAD" }, env)).rejects.toThrow("binding changed");
    await rm(left.path, { recursive: true, force: true });
    await expect(prepareProjectWorktree(state, repository, { ...first, reuse: true }, env)).rejects.toThrow("workspace is missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});
