import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCommit, mioSsh, mioUpdatePlatforms } from "./deploy-mio.ts";

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

test("Mio publishes its Linux x64 binary and adds platforms for managed Runtimes", () => {
  const runtime = { protocol_version: 2, name: "synthetic", engines: [], tags: [], max_concurrent: 1,
    version: "0.2.2", features: ["self_update"], install: "managed" };
  expect(mioUpdatePlatforms([])).toEqual(["darwin-arm64", "linux-x64"]);
  expect(mioUpdatePlatforms([{ ...runtime, platform: "linux-x64" }, { ...runtime, platform: "linux-arm64", install: "external" }]))
    .toEqual(["darwin-arm64", "linux-x64"]);
  expect(mioUpdatePlatforms([{ ...runtime, platform: "linux-arm64" }, { ...runtime, platform: "linux-arm64" }]))
    .toEqual(["darwin-arm64", "linux-x64", "linux-arm64"]);
});
