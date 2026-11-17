import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interactiveWorkspace, jobEngineCapabilities, type JobEngineConfig } from "../src/job-engine-config.ts";

test("a bound Codex Job can open its own workspace and rejects aliases to private directories", async () => {
  const temp = await mkdtemp(join(await realpath(tmpdir()), "lumio-job-workspace-"));
  try {
    const home = join(temp, "home"), project = join(home, "project"), state = join(home, "runtime-state");
    const privateDir = join(home, ".ssh"), child = join(privateDir, "subdir"), hubState = join(home, ".local/share/lumio");
    const engineDir = join(home, "engine-bin"), other = join(temp, "other"), alias = join(home, "alias");
    await Promise.all([project, state, child, hubState, engineDir, other].map(path => mkdir(path, { recursive: true })));
    await symlink(privateDir, alias);
    const provider: JobEngineConfig = { engine: "codex", executable: join(engineDir, "codex"), version: "0.166.0", roots: [] };
    const workspace = (workdir: string, roots: string[] = [], git: string[] = [], bound = true) => interactiveWorkspace(workdir, state, { ...provider, roots }, git, bound, home);
    expect(await workspace(project)).toEqual({ cwd: project, gitPaths: [] });
    expect(await workspace(project, [], [], false)).toBeUndefined();
    expect(await interactiveWorkspace(project, state, { ...provider, engine: "claude-code" }, [], true, home)).toBeUndefined();
    expect(await workspace(other, [project])).toBeUndefined();
    expect(await workspace(project, [project], [], false)).toMatchObject({ cwd: project });
    for (const path of [home, temp, state, child, alias, hubState, engineDir, "."]) expect(await workspace(path)).toBeUndefined();
    expect(await workspace(project, [], [alias])).toBeUndefined();
    expect(await workspace(project, [], [other])).toEqual({ cwd: project, gitPaths: [other] });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "darwin")("without configured roots only the managed Codex account capability is advertised", async () => {
  const temp = await mkdtemp(join(await realpath(tmpdir()), "lumio-job-capability-"));
  try {
    await writeFile(join(temp, "codex"), '#!/bin/sh\nprintf "codex-cli 0.166.0\\n"\n', { mode: 0o700 });
    const engines = [{ name: "codex" as const, version: "0.166.0", sandbox: "os" as const }];
    const env = { PATH: `${temp}:/usr/bin:/bin`, LUMIO_JOB_CODEX_API_KEY: "synthetic-key" };
    expect(await jobEngineCapabilities(engines, env, false)).toMatchObject([{ approvals: false, questions: false }]);
    expect(await jobEngineCapabilities(engines, env, true)).toMatchObject([{ approvals: false, questions: false, account_reuse: true }]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
