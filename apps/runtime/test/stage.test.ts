import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobSpec } from "@lumio/schema";
import { jobEnv } from "../src/executor.ts";
import { gitWritePaths, stageSecrets } from "../src/stage.ts";

test("Git grants resolve a linked checkout and do not authorize a parent checkout", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "lumio-stage-git-")));
  const repo = join(temp, "repo"), linked = join(temp, "linked");
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], { cwd: temp, env: { ...jobEnv(process.env), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(child.exitCode).toBe(0);
  };
  try {
    git("init", repo);
    git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture");
    git("-C", repo, "worktree", "add", "-b", "linked", linked);
    const subdirectory = join(repo, "subdirectory");
    await mkdir(subdirectory);
    expect(gitWritePaths(repo, process.env)).toEqual([join(repo, ".git")]);
    expect(gitWritePaths(linked, process.env)).toEqual([join(repo, ".git"), join(repo, ".git", "worktrees", "linked")]);
    expect(gitWritePaths(subdirectory, process.env)).toEqual([]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("hooks run in order, receive context and a redacted report, and can prevent the agent from starting", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lumio-stage-hooks-"));
  const synthetic = 'synthetic-"fixture"-value', task = "task_00000000000000000000000001";
  const runtimeEnv = { PATH: process.env.PATH, LUMIO_SECRET_fixture: synthetic, LUMIO_SECRET_other: "another-synthetic-fixture" };
  const permissionEnv = stageSecrets({ secrets: ["fixture"] }, runtimeEnv);
  expect(stageSecrets({ secrets: ["absent"] }, runtimeEnv)).toBeUndefined();
  expect(stageSecrets(undefined, runtimeEnv)).toEqual({});
  expect(stageSecrets({ secrets: ["github-merge"] }, { LUMIO_SECRET_githubHmerge: synthetic, LUMIO_SECRET_github_merge: "ungranted" }))
    .toEqual({ LUMIO_SECRET_githubHmerge: synthetic });
  expect(permissionEnv).toEqual({ LUMIO_SECRET_fixture: synthetic });
  const completion = join(temp, "completion.json"), hookReportFile = join(temp, "report.txt");
  const invoke = async (before: string) => {
    const spec = JobSpec.parse({ protocol_version: 2, id: "job_00000000000000000000000001",
      runtime: "act_00000000000000000000000001", lease: "synthetic-stage-lease", source: { task, round: 3 },
      workdir: temp, timeout_seconds: 120, created: "2026-11-10T00:00:00Z",
      run: { kind: "agent", engine: "pi", prompt: "Lumio stage ID: review\nSynthetic task", hooks: {
        before: { argv: ["/bin/sh", "-ec", before] },
        after: { argv: ["/bin/sh", "-ec", 'test -z "$LUMIO_SECRET_fixture"; cat "$LUMIO_REPORT_FILE"; echo after'] },
      } },
    });
    const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "--job-worker"], {
      stdin: new Blob([JSON.stringify({ spec, completion, hookReportFile, hookEnv: jobEnv(runtimeEnv),
        redactions: [synthetic], env: { ...jobEnv(runtimeEnv), ...permissionEnv },
        argv: ["/bin/sh", "-ec", 'test -f before; test -z "$LUMIO_SECRET_other"; printf "%s" "$LUMIO_SECRET_fixture"'] })]),
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    return { stdout, stderr, exit: JSON.parse(await readFile(completion, "utf8")) };
  };
  try {
    const failed = await invoke("echo refused >&2; exit 7");
    expect(failed.exit).toMatchObject({ exit_code: 7, error: expect.stringContaining("refused") });
    expect(failed.stdout).toBe("");
    expect(failed.stderr).not.toContain("[Lumio after hook]");
    const success = await invoke(`test "$LUMIO_TASK_ID" = "${task}"; test "$LUMIO_STAGE_ID" = review; test "$LUMIO_ROUND" = 3; test -z "$LUMIO_SECRET_fixture"; touch before`);
    expect(success.exit).toEqual({ exit_code: 0 });
    expect(success.stdout).toBe(synthetic); // Executor applies its streaming redactor before any durable logging.
    expect(success.stderr).toContain("[REDACTED]");
    expect(success.stderr).not.toContain(synthetic);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
