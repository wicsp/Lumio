import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./update-preview.sh", import.meta.url));

test("preview updater requires an explicit committed ref", () => {
  const result = Bun.spawnSync(["bash", script]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("<分支、标签或提交>");
});

test("preview updater accepts a feature ref without switching the current checkout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lumio-preview-checkout-"));
  try {
    function git(...args: string[]): string {
      const result = Bun.spawnSync(["git", ...args], { cwd });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    }
    git("init", "--initial-branch", "main");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "baseline");
    git("branch", "feature");
    await writeFile(join(cwd, "uncommitted.txt"), "synthetic change");
    const missing = Bun.spawnSync(["bash", script, "unknown"], { cwd });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("找不到已提交的版本");
    await writeFile(join(cwd, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o700 });
    const feature = Bun.spawnSync(["bash", script, "feature"], {
      cwd,
      env: { ...process.env, PATH: [cwd, process.env.PATH].filter(Boolean).join(delimiter) },
    });
    expect(feature.exitCode).toBe(1);
    expect(feature.stderr.toString()).toContain("需要 macOS launchd");
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("status", "--porcelain")).toContain("?? uncommitted.txt");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
