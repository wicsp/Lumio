import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexJobFilesystem, jobGitToolchain } from "../src/job-codex-sandbox.ts";
import { isolatedEnvironment, seatbelt } from "../src/native/isolation.ts";

test.skipIf(process.platform !== "darwin")("Codex Job Seatbelt supports Git according to the stage grant", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "codex-job-boundary-"));
  try {
    const cwd = join(dir, "repo"), state = join(dir, "session"), linked = join(cwd, "feature");
    const outside = join(dir, "private"), remote = join(state, "tmp", "origin.git");
    const git = jobGitToolchain({ PATH: "/usr/bin:/bin" });
    expect(git).toBeDefined();
    if (!git) return;
    const { executable, readPaths } = git;
    await mkdir(cwd);
    await mkdir(join(cwd, ".agents"));
    await mkdir(join(state, "tmp"), { recursive: true });
    await mkdir(join(state, "codex"));
    await writeFile(outside, "synthetic private data");
    await symlink(outside, join(cwd, "outside-link"));
    const env = {
      ...isolatedEnvironment(state, join(state, "codex"), executable),
      PATH: `${dirname(executable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
    };
    function shell(workspace: string, writable: boolean, gitPaths: string[], gitReads: string[] = []) {
      const profile = seatbelt(state, "/bin/sh", [workspace, ...gitPaths, ...gitReads, ...readPaths])
        + codexJobFilesystem(workspace, state, writable, gitPaths);
      return (...argv: string[]) => Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, ...argv], {
        cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
    }
    function succeeds(run: ReturnType<typeof shell>, ...argv: string[]) {
      const result = run(...argv);
      expect(result.stderr.toString(), argv.join(" ")).not.toContain("Operation not permitted");
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    }
    function denied(run: ReturnType<typeof shell>, ...argv: string[]) {
      expect(run(...argv).exitCode, argv.join(" ")).not.toBe(0);
    }
    const common = join(cwd, ".git"), develop = shell(cwd, true, [common]);
    const commitArgs = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm"];
    succeeds(develop, "git", "init", "-qb", "main");
    succeeds(develop, "git", ...commitArgs, "Initial");
    succeeds(develop, "git", "init", "--bare", "-qb", "main", remote);
    succeeds(develop, "git", "remote", "add", "origin", remote);
    succeeds(develop, "git", "push", "-qu", "origin", "main");

    const inspect = shell(cwd, false, []), edit = shell(cwd, true, []);
    succeeds(inspect, "/usr/bin/true");
    expect(succeeds(inspect, "git", "log", "-1", "--format=%s")).toBe("Initial");
    succeeds(edit, "git", "status", "--short");
    succeeds(edit, "/usr/bin/touch", "editable");
    denied(inspect, "/usr/bin/touch", "read-only");
    denied(edit, "git", "config", "--local", "lumio.fixture", "blocked");
    denied(edit, "/usr/bin/touch", ".git/blocked");
    denied(edit, "/usr/bin/touch", ".agents/blocked");
    denied(edit, "/usr/bin/touch", join(state, "codex", "config.toml"));
    denied(edit, "/usr/bin/touch", join(state, ".business-writer.sqlite"));
    for (const path of [outside, "outside-link"]) {
      denied(inspect, "/bin/cat", path);
      denied(develop, "/bin/cat", path);
    }

    succeeds(develop, "git", "worktree", "add", "-qb", "feature", linked, "main");
    succeeds(develop, "git", "worktree", "add", "-qb", "sibling", join(cwd, "sibling"), "main");
    const metadata = join(common, "worktrees", "feature");
    const linkedInspect = shell(linked, false, [], [common, metadata]);
    expect(succeeds(linkedInspect, "git", "log", "-1", "--format=%s")).toBe("Initial");
    denied(linkedInspect, "git", "config", "--local", "lumio.fixture", "blocked");
    const linkedDevelop = shell(linked, true, [common, metadata]);
    succeeds(linkedDevelop, "git", "pull", "--ff-only", "origin", "main");
    succeeds(linkedDevelop, "git", ...commitArgs, "Feature");
    succeeds(linkedDevelop, "git", "push", "-qu", "origin", "feature");
    denied(linkedDevelop, "/usr/bin/touch", join(common, "worktrees", "sibling", "blocked"));
    succeeds(develop, "git", "merge", "--ff-only", "feature");
    expect(succeeds(develop, "git", "log", "-1", "--format=%s")).toBe("Feature");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
