import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { buildSigningKey, managedPlatforms, publishBuildUpdates } from "./build-updates.ts";
import { verifyArtifact, verifyManifest } from "../packages/platform/src/index.ts";
import { assertHubIdle } from "./deploy-local.ts";

test("development publisher selects managed platforms, signs all artifacts, retains two versions and protects the key", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-build-updates-"));
  try {
    const key = await buildSigningKey(join(root, "keys")); expect((await stat(join(root, "keys/private.pem"))).mode & 0o777).toBe(0o600);
    expect((await buildSigningKey(join(root, "keys"))).fingerprint).toBe(key.fingerprint);
    const reg = { protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1, version: "0.2.2", features: ["self_update"], platform: "linux-x64" };
    expect(managedPlatforms([{ ...reg, install: "managed" }, { ...reg, install: "external", platform: "linux-arm64" }, { ...reg, install: "hub-shared", platform: "darwin-arm64" }])).toEqual(["linux-x64"]);
    const build = join(root, "build"), updates = join(root, "updates"); await mkdir(build);
    for (const [n, previous] of [[1, undefined], [2, "0.2.3-dev.local.1"], [3, "0.2.3-dev.local.2"]] as const) {
      await publishBuildUpdates({ root: updates, build, version: `0.2.3-dev.local.${n}`, commit: String(n).repeat(40), previous, key: key.privateKey, platforms: ["linux-x64", "linux-arm64"],
        compile: async (_, path) => { await writeFile(path, "synthetic program"); }, run: async argv => { const p = Bun.spawn(argv); expect(await p.exited).toBe(0); } });
    }
    expect((await readdir(updates)).filter(name => name.startsWith("0."))).toEqual(["0.2.3-dev.local.2", "0.2.3-dev.local.3"]);
    const directory = join(updates, "0.2.3-dev.local.3");
    const manifest = verifyManifest(await readFile(join(directory, "manifest.json")), await readFile(join(directory, "manifest.sig"), "utf8"), [key.publicKey], "0.2.3-dev.local.3");
    expect(manifest.artifacts).toHaveLength(2);
    for (const artifact of manifest.artifacts) verifyArtifact(await readFile(join(directory, artifact.file)), artifact);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("deployment waits for Hub turns but does not block on Runtime jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-deploy-idle-")), path = join(root, "hub.sqlite"), db = new Database(path);
  try {
    db.exec("CREATE TABLE jobs(record TEXT); CREATE TABLE assistant_turns(status TEXT); INSERT INTO jobs VALUES ('{\"status\":\"running\"}')");
    expect(() => assertHubIdle(path)).not.toThrow();
    db.exec("INSERT INTO assistant_turns VALUES ('running')"); expect(() => assertHubIdle(path)).toThrow("Hub assistant");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
