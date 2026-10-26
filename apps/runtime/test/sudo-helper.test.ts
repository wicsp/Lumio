import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivilegedApproval, privilegedSigningPayload } from "@lumio/schema";
import { executeApproval } from "../src/sudo-helper.ts";
import { readConfig } from "../src/config.ts";

let temp: string, config: string, used: string, output: string, grant: PrivilegedApproval;
const keys = generateKeyPairSync("ed25519");
const now = Date.parse("2026-10-26T00:00:00Z");
function signed(patch: Partial<PrivilegedApproval> = {}) {
  const { signature: _, ...fields } = { ...grant, ...patch };
  return PrivilegedApproval.parse({ ...fields, signature: sign(null, Buffer.from(privilegedSigningPayload(fields)), keys.privateKey).toString("base64url") });
}
function run(value: unknown, patch = {}) {
  return executeApproval(value, { config, used, now: () => now, uid: 0, owner: process.getuid!(), stdout: (c) => { output += c.toString(); }, stderr: () => {}, ...patch });
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-helper-")); config = join(temp, "sudo.json"); used = join(temp, "used"); output = "";
  await writeFile(config, JSON.stringify({ public_key: keys.publicKey.export({ format: "jwk" }).x, runtime: "act_00000000000000000000000001" }), { mode: 0o600 });
  grant = signed({ proposal: "prop_00000000000000000000000001", runtime: "act_00000000000000000000000001", job: "job_00000000000000000000000001", argv: ["/usr/bin/env"], approved_by: "act_00000000000000000000000002", approved_at: new Date(now).toISOString(), expires: new Date(now + 600_000).toISOString() });
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

test("valid signed command executes once with minimal environment; replay is refused", async () => {
  expect(await run(grant)).toBe(0);
  expect(output.trim().split("\n").sort()).toEqual(["LANG=C.UTF-8", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]);
  expect(await readFile(used, "utf8")).toBe(grant.proposal + "\n");
  output = ""; await expect(run(grant)).rejects.toThrow("用过"); expect(output).toBe("");
});

test("bad signatures, runtime, expiry, relative argv, uid and unsafe permissions never execute", async () => {
  for (const bad of [{ ...grant, argv: ["/bin/false"] }, signed({ runtime: "act_00000000000000000000000009" }),
    signed({ expires: new Date(now).toISOString() }), signed({ argv: ["echo"] }), { ...grant, extra: true }]) {
    await expect(run(bad)).rejects.toThrow();
  }
  await expect(run(grant, { uid: 1 })).rejects.toThrow("root");
  await chmod(config, 0o666); await expect(run(grant)).rejects.toThrow("权限"); await chmod(config, 0o600);
  await writeFile(used, "", { mode: 0o666 }); await chmod(used, 0o666); await expect(run(grant)).rejects.toThrow("权限");
  expect(output).toBe("");
});

test("symlinks and concurrent replay are refused; failed execution still consumes the approval", async () => {
  await symlink(config, used); await expect(run(grant)).rejects.toThrow(); await rm(used);
  const values = await Promise.allSettled([run(grant), run(grant)]);
  expect(values.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const fails = signed({ proposal: "prop_00000000000000000000000002", argv: ["/not/installed"] });
  expect(await run(fails)).toBe(127); await expect(run(fails)).rejects.toThrow("用过");
});

test("configuration validates sudo prefix and wait deadline", () => {
  const env = { LUMIO_HUB_URL: "http://localhost:1", LUMIO_TOKEN: "fixture", LUMIO_RUNTIME_NAME: "test" };
  expect(readConfig(env).sudoTimeout).toBe(1800);
  expect(readConfig(env).sudoCommand).toEqual([]);
  for (const patch of [{ LUMIO_RUNTIME_SUDO_COMMAND: "sudo -n helper" }, { LUMIO_RUNTIME_SUDO_TIMEOUT: "0" }, { LUMIO_RUNTIME_SUDO_TIMEOUT: "NaN" }]) expect(() => readConfig({ ...env, ...patch })).toThrow();
});

test("approved programs start in the fixed root working directory and timeout consumes the grant", async () => {
  expect(await run(signed({ argv: ["/bin/pwd"] }))).toBe(0); expect(output).toBe("/\n");
  const slow = signed({ proposal: "prop_00000000000000000000000003", argv: ["/bin/sleep", "60"] });
  expect(await run(slow, { timeoutMs: 30 })).toBe(137); await expect(run(slow)).rejects.toThrow("用过");
});
