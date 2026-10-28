import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CliConfig, ClientInvite, ClientJoinRequest, HubSigningKey, PairingCode, RuntimeInvite, RuntimeJoin, RuntimeJoinRequest, signingKeyFingerprint } from "../src/index.ts";

// ADR 0021：安装与配对的契约。
const code = "abcdefghijklmnopqrstuvwxyz";
test("CLI config is strict; vault optional", () => {
  expect(CliConfig.parse({ hub_url: "http://127.0.0.1:7420", token: "synthetic" })).toEqual({ hub_url: "http://127.0.0.1:7420", token: "synthetic" });
  expect(CliConfig.safeParse({ hub_url: "not a url", token: "x" }).success).toBe(false);
  expect(CliConfig.safeParse({ hub_url: "http://x", token: "x", extra: 1 }).success).toBe(false);
});

test("pairing codes are long lowercase base32; invites and joins are strict", () => {
  expect(PairingCode.safeParse(code).success).toBe(true);
  for (const bad of ["short", code.toUpperCase(), `${code}1`, `${code}!`]) expect(PairingCode.safeParse(bad).success).toBe(false);
  const invite = { name: "server", actor: "act_01M5AAAAAAAAAAAAAAAAAAAAA1", code, expires: "2026-10-28T10:10:00Z", hub_url: "https://mac.example.ts.net",
    command: `curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh -s -- runtime --hub https://mac.example.ts.net --code ${code}` };
  expect(RuntimeInvite.parse(invite)).toEqual(invite);
  expect(RuntimeJoinRequest.safeParse({ code, name: "x" }).success).toBe(false);
  expect(RuntimeJoin.parse({ name: "server", actor: invite.actor, token: "synthetic" }).name).toBe("server");
});

test("signing key fingerprint is the first 8 bytes of SHA-256, grouped", () => {
  const raw = Buffer.alloc(32, 7);
  const fingerprint = signingKeyFingerprint(createHash("sha256").update(raw).digest("hex"));
  expect(fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  expect(HubSigningKey.parse({ public_key: raw.toString("base64url"), fingerprint }).fingerprint).toBe(fingerprint);
  expect(() => signingKeyFingerprint("xyz")).toThrow();
});

test("client invites pair another machine's CLI", () => {
  const invite = { name: "cli@macbook", code, expires: "2026-10-28T10:10:00Z", hub_url: "https://lumio.example.org", command: `lumio login https://lumio.example.org --code ${code}` };
  expect(ClientInvite.parse(invite)).toEqual(invite);
  expect(ClientInvite.safeParse({ ...invite, name: "Bad Name" }).success).toBe(false);
  expect(ClientJoinRequest.safeParse({ code: "short" }).success).toBe(false);
});
