import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./update-preview.sh", import.meta.url));

test.each([
  { branch: "feature", dirty: false, message: "专用 preview 工作树" },
  { branch: "preview", dirty: true, message: "preview 工作树须干净" },
])("preview updater rejects $branch with dirty=$dirty before deploying", async ({ branch, dirty, message }) => {
  const cwd = await mkdtemp(join(tmpdir(), "lumio-preview-checkout-"));
  try {
    const init = Bun.spawnSync(["git", "init", "--initial-branch", branch, cwd]);
    expect(init.exitCode).toBe(0);
    if (dirty) await writeFile(join(cwd, "uncommitted.txt"), "synthetic change");
    const result = Bun.spawnSync(["bash", script], { cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(message);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
