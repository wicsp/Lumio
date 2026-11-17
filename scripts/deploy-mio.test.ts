import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCommit, mioSsh } from "./deploy-mio.ts";

test("Mio deployment uses the configured alias, pinned host keys and no agent forwarding", () => {
  expect(mioSsh()).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ForwardAgent=no", "-o", "ConnectTimeout=10", "mio"]);
  expect(mioSsh("192.0.2.20").slice(-3)).toEqual(["-o", "HostName=192.0.2.20", "mio"]);
  expect(() => mioSsh("example.org -o ProxyCommand=example")).toThrow("Invalid LUMIO_MIO_SSH_HOSTNAME");
});

test("Mio exports the complete commit when called from the scripts directory", async () => {
  const destination = mkdtempSync(join(tmpdir(), "lumio-mio-test-"));
  try {
    exportCommit(import.meta.dir, "HEAD", destination);
    expect((await Bun.file(join(destination, "package.json")).json()).name).toBe("lumio");
    expect(await Bun.file(join(destination, "apps/cli/src/build-binary.ts")).exists()).toBe(true);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
