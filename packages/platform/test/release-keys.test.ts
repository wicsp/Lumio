import { expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { RELEASE_PUBLIC_KEYS } from "../src/release-keys.ts";

test("release public keys are unique Ed25519 SPKI keys", () => {
  expect(RELEASE_PUBLIC_KEYS.length).toBeGreaterThan(0);
  expect(new Set(RELEASE_PUBLIC_KEYS).size).toBe(RELEASE_PUBLIC_KEYS.length);
  for (const key of RELEASE_PUBLIC_KEYS) {
    expect(createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }).asymmetricKeyType).toBe("ed25519");
  }
});
