import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { JobSpec, JobResult } from "@lumio/schema";
import { privateFile } from "./service.ts";

type Worktree = NonNullable<JobSpec["worktree"]>;
interface Binding {
  repository: string;
  base: string;
  commit: string;
  ready: boolean;
}

async function existing(path: string) {
  try { return await lstat(path); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
}

export async function prepareProjectWorktree(stateDir: string, workdir: string, spec: Worktree, env: NodeJS.ProcessEnv): Promise<NonNullable<JobResult["workspace"]>> {
  const git = Bun.which("git", { PATH: env.PATH ?? "" });
  if (!git || !isAbsolute(workdir)) throw new Error("Project checkout is unavailable");
  const repository = await realpath(workdir);
  const gitEnv = { PATH: env.PATH, HOME: env.HOME };
  const execute = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn([git, "-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
      env: gitEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 30_000,
    });
    const output = (await new Response(child.stdout).text()).trim();
    if (await child.exited !== 0) throw new Error("Git worktree operation failed");
    return output;
  };
  if (await realpath(await execute(repository, "rev-parse", "--show-toplevel")) !== repository) {
    throw new Error("Project directory is not a Git root");
  }
  const state = await realpath(stateDir);
  const root = state + "-worktrees";
  const bindings = join(state, "project-worktrees");
  for (const directory of [root, bindings]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new Error("Unexpected workspace root");
  }
  const key = `${spec.project}-${spec.task}`;
  const path = join(root, key), record = join(bindings, key + ".json");
  const branch = `lumio/${spec.task}`;
  const saved = await existing(record);
  if (saved && !saved.isFile()) throw new Error("Invalid workspace binding");
  let binding: Binding | undefined = saved ? JSON.parse(await readFile(record, "utf8")) : undefined;
  if (binding && (binding.repository !== repository || binding.base !== spec.base || !/^[0-9a-f]{40,64}$/.test(binding.commit))) {
    throw new Error("Project workspace binding changed");
  }
  const previous = await existing(path);
  if (!binding) {
    if (spec.reuse || previous) throw new Error("Previously bound workspace is unavailable");
    const commit = await execute(repository, "rev-parse", "--verify", "--end-of-options", spec.base + "^{commit}");
    binding = { repository, base: spec.base, commit, ready: false };
    await privateFile(record, JSON.stringify(binding));
  }
  if (!previous) {
    if (binding.ready) throw new Error("Project workspace is missing");
    await execute(repository, "worktree", "add", "-b", branch, "--", path, binding.commit);
  }
  if (await realpath(path) !== path || await realpath(await execute(path, "rev-parse", "--show-toplevel")) !== path
    || await execute(path, "symbolic-ref", "HEAD") !== `refs/heads/${branch}`) {
    throw new Error("Project workspace checkout changed");
  }
  const common = async (cwd: string) => realpath(resolve(cwd, await execute(cwd, "rev-parse", "--git-common-dir")));
  if (await common(path) !== await common(repository) || dirname(path) !== root) throw new Error("Workspace belongs to a different repository");
  if (!binding.ready) await privateFile(record, JSON.stringify({ ...binding, ready: true }));
  return { path, branch, base_commit: binding.commit };
}
