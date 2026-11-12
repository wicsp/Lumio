import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CONTRACTS, ExecutionRuntimeUpdateCommandRequest, ReleaseManifest, RuntimeHeartbeat, RuntimeInfo, RuntimeRegistration,
  RuntimeSync, RuntimeUpdateDirective, RuntimeUpdateReport,
} from "../src/index.ts";

const now = "2026-11-12T16:30:00+08:00";
const base = { protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1 } as const;
const sha = "a".repeat(64);
const commit = "0123456789abcdef0123456789abcdef01234567";

describe("U1-1 runtime registration", () => {
  test("old registrations stay valid", () => {
    expect(RuntimeRegistration.safeParse(base).success).toBe(true);
    expect(RuntimeRegistration.safeParse({ ...base, features: ["hooks"] }).success).toBe(true);
  });
  test("self_update requires version, platform and install", () => {
    expect(RuntimeRegistration.safeParse({ ...base, features: ["self_update"] }).success).toBe(false);
    expect(RuntimeRegistration.safeParse({ ...base, features: ["self_update"], version: "0.4.0", platform: "linux-x64" }).success).toBe(false);
    expect(RuntimeRegistration.safeParse({ ...base, features: ["self_update"], version: "0.4.0", platform: "linux-x64", install: "managed" }).success).toBe(true);
  });
  test("version and platform are validated", () => {
    expect(RuntimeRegistration.safeParse({ ...base, version: "v0.4.0" }).success).toBe(false);
    expect(RuntimeRegistration.safeParse({ ...base, version: "0.4.0-dev.local.1a2b3c4" }).success).toBe(true);
    expect(RuntimeRegistration.safeParse({ ...base, platform: "linux-x64-musl" }).success).toBe(false);
    expect(RuntimeRegistration.safeParse({ ...base, install: "nix" }).success).toBe(false);
  });
});

describe("U1-1 update report", () => {
  test("current has no target; other states need one", () => {
    expect(RuntimeUpdateReport.safeParse({ state: "current", since: now }).success).toBe(true);
    expect(RuntimeUpdateReport.safeParse({ state: "current", target: "0.4.0", since: now }).success).toBe(false);
    expect(RuntimeUpdateReport.safeParse({ state: "draining", since: now }).success).toBe(false);
    expect(RuntimeUpdateReport.safeParse({ state: "draining", target: "0.4.0", since: now }).success).toBe(true);
  });
  test("failed and blocked need a reason, others must not have one", () => {
    expect(RuntimeUpdateReport.safeParse({ state: "failed", target: "0.4.0", since: now }).success).toBe(false);
    expect(RuntimeUpdateReport.safeParse({ state: "failed", target: "0.4.0", since: now, reason: "confirm_failed", previous: "0.3.9" }).success).toBe(true);
    expect(RuntimeUpdateReport.safeParse({ state: "blocked", target: "0.4.0-dev.local.abc1234", since: now, reason: "untrusted_build" }).success).toBe(true);
    expect(RuntimeUpdateReport.safeParse({ state: "staged", target: "0.4.0", since: now, reason: "download_failed" }).success).toBe(false);
  });
  test("heartbeat accepts an optional report and still rejects unknown fields", () => {
    const heartbeat = { running: [], queued: [], outbox: 0 };
    expect(RuntimeHeartbeat.safeParse(heartbeat).success).toBe(true);
    expect(RuntimeHeartbeat.safeParse({ ...heartbeat, update: { state: "waiting_idle", target: "0.4.0", since: now } }).success).toBe(true);
    expect(RuntimeHeartbeat.safeParse({ ...heartbeat, version: "0.4.0" }).success).toBe(false);
  });
});

describe("U1-1 directive and view", () => {
  test("sync carries an optional directive", () => {
    const sync = { jobs: [], cancel: [], routines: [] };
    expect(RuntimeSync.safeParse(sync).success).toBe(true);
    expect(RuntimeSync.safeParse({ ...sync, update: { version: "0.4.0", hold: false } }).success).toBe(true);
    expect(RuntimeSync.safeParse({ ...sync, update: { version: "0.4.0" } }).success).toBe(false);
    expect(RuntimeUpdateDirective.safeParse({ version: "0.4.0", hold: false, restart_now: "short" }).success).toBe(false);
    expect(RuntimeUpdateDirective.safeParse({ version: "0.4.0", hold: false, restart_now: "req_01JCRESTARTNOW0001" }).success).toBe(true);
    expect(RuntimeUpdateDirective.safeParse({ version: "0.4.0", hold: false, url: "https://example.com/lumio.tgz" }).success).toBe(false);
  });
  test("runtime info exposes the update view", () => {
    const info = { actor: "act_01JCZZZZZZZZZZZZZZZZZZZZZZ", registration: base, last_seen: now, online: true };
    expect(RuntimeInfo.safeParse(info).success).toBe(true);
    expect(RuntimeInfo.safeParse({ ...info, update: { policy: "follow", desired: "0.4.0", hold: false,
      report: { state: "downloading", target: "0.4.0", since: now } } }).success).toBe(true);
    expect(RuntimeInfo.safeParse({ ...info, update: { policy: "auto", hold: false } }).success).toBe(false);
  });
});

describe("U1-1 release manifest", () => {
  const manifest = { format: 1, version: "0.4.0", channel: "release", commit, created: now,
    artifacts: [{ platform: "linux-x64", file: "lumio-linux-x64.tar.gz", size: 1024, sha256: sha }] };
  test("valid release and dev manifests", () => {
    expect(ReleaseManifest.safeParse(manifest).success).toBe(true);
    expect(ReleaseManifest.safeParse({ ...manifest, version: "0.4.0-dev.local.1a2b3c4", channel: "dev" }).success).toBe(true);
  });
  test("channel must match the version suffix", () => {
    expect(ReleaseManifest.safeParse({ ...manifest, channel: "dev" }).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...manifest, version: "0.4.0-dev.local.1a2b3c4" }).success).toBe(false);
  });
  test("artifacts are unique, named after their platform, and hashed", () => {
    const artifact = manifest.artifacts[0]!;
    expect(ReleaseManifest.safeParse({ ...manifest, artifacts: [artifact, artifact] }).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...manifest, artifacts: [{ ...artifact, file: "lumio-linux-arm64.tar.gz" }] }).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...manifest, artifacts: [{ ...artifact, sha256: sha.toUpperCase() }] }).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...manifest, artifacts: [] }).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...manifest, format: 2 }).success).toBe(false);
  });
});

describe("U1-1 human commands", () => {
  const request = (operation: unknown) => ExecutionRuntimeUpdateCommandRequest.safeParse({ request_id: "req_01JCUPDATECOMMAND01", operation });
  test("policy, hold, restart_now and retry", () => {
    expect(request({ op: "execution.runtime.update.policy", args: { runtime: "server", policy: "manual" } }).success).toBe(true);
    expect(request({ op: "execution.runtime.update.hold", args: { runtime: "server", version: "0.4.0", hold: true } }).success).toBe(true);
    expect(request({ op: "execution.runtime.update.restart_now", args: { runtime: "server", version: "0.4.0" } }).success).toBe(true);
    expect(request({ op: "execution.runtime.update.retry", args: { runtime: "server", version: "0.4.0" } }).success).toBe(true);
  });
  test("actions carry the version the human saw", () => {
    expect(request({ op: "execution.runtime.update.restart_now", args: { runtime: "server" } }).success).toBe(false);
    expect(request({ op: "execution.runtime.update.install", args: { runtime: "server", version: "0.4.0" } }).success).toBe(false);
  });
});

test("U1-1 contracts are registered and exportable", () => {
  for (const name of ["runtime-update-report", "runtime-update-directive", "runtime-update-command-request", "release-manifest"]) {
    expect(name in CONTRACTS).toBe(true);
    expect(() => z.toJSONSchema(CONTRACTS[name as keyof typeof CONTRACTS], { io: "input" })).not.toThrow();
  }
});
