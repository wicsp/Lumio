import { afterEach, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { mkdtemp, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptPush, validatePushKeys, VapidKeys, pushSubject } from "../src/web-push.ts";
import { pushReceiver, verifyVapid } from "./fixtures/push.ts";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("RFC 8291 section 5 and appendix A encryption vector matches every byte", () => {
  const sender = createECDH("prime256v1"); sender.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
  const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
  const encrypted = encryptPush(Buffer.from("When I grow up, I want to be a watermelon"), keys, sender, Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"));
  expect(encrypted.toString("base64url")).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("RFC 8292 section 2.4 public key and JWT signature vector verifies", () => {
  const value = verifyVapid("vapid t=eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA, k=BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs");
  expect(value.header).toEqual({ typ: "JWT", alg: "ES256" });
  expect(value.claims).toEqual({ aud: "https://push.example.net", exp: 1453523768, sub: "mailto:push@example.com" });
});

test("fresh encryption decrypts; VAPID is lazy, private, persistent, correctly signed and separate from ECDH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumio-push-crypto-")); dirs.push(dir);
  const keys = new VapidKeys(dir), file = join(dir, "push-vapid.pem");
  expect(await stat(file).catch(() => null)).toBeNull();
  const publicKey = keys.publicKey();
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await chmod(file, 0o644);
  expect(new VapidKeys(dir).publicKey()).toBe(publicKey);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const now = new Date("2026-11-05T00:00:00Z");
  const auth = keys.authorization("https://push.example.test:8443/secret", now, "https://hub.example.test");
  const decoded = verifyVapid(auth);
  expect(decoded.claims).toEqual({ aud: "https://push.example.test:8443", exp: now.getTime() / 1000 + 43200, sub: "https://hub.example.test" });
  expect(decoded.publicKey).toBe(publicKey);
  for (const missing of [undefined, "", "http://hub.example.test", "https://user:secret@hub.example.test"]) {
    expect(() => keys.authorization("https://push.example.test/synthetic", now, missing as string)).toThrow("HTTPS VAPID subject required");
  }
  expect(pushSubject("https://hub.example.test", "https://fallback.example.test")).toBe("https://hub.example.test");
  expect(pushSubject("http://hub.example.test", "https://fallback.example.test")).toBe("https://fallback.example.test");
  const receiver = pushReceiver(), payload = { title: "合成标题", kind: "turn.answer", path: "#work/task_synthetic" };
  const first = encryptPush(Buffer.from(JSON.stringify(payload)), receiver.subscription.keys);
  const second = encryptPush(Buffer.from(JSON.stringify(payload)), receiver.subscription.keys);
  expect(receiver.decrypt(first)).toEqual(payload); expect(receiver.decrypt(second)).toEqual(payload);
  expect(first.equals(second)).toBe(false);
  expect(first.subarray(21, 86).toString("base64url")).not.toBe(publicKey);
  expect(() => validatePushKeys({ p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: receiver.subscription.keys.auth })).toThrow();
  expect(() => encryptPush(Buffer.alloc(3994), receiver.subscription.keys)).toThrow();
});
