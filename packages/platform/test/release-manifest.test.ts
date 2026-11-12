import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { ReleaseManifest } from "@lumio/schema";
import { keyFingerprint, permitsUnsignedRelease, publicKeyPEM, signManifest, verifyArtifact, verifyManifest } from "../src/release-manifest.ts";
const keys = generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const priv = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const manifest = ReleaseManifest.parse({ format: 1, version: "0.2.3", channel: "release", commit: "a".repeat(40), created: "2026-11-12T00:00:00Z", artifacts: [{ platform: "linux-x64", file: "lumio-linux-x64.tar.gz", size: 1, sha256: "0".repeat(64) }] });
test("manifest signatures authenticate raw bytes and the expected version", () => {
  const bytes = Buffer.from(JSON.stringify(manifest)), signature = signManifest(bytes, priv);
  expect(verifyManifest(bytes, signature, [pub], "0.2.3")).toEqual(manifest);
  expect(() => verifyManifest(Buffer.concat([bytes, Buffer.from(" ")]), signature, [pub])).toThrow("signature_invalid");
  expect(() => verifyManifest(bytes, signature, [], "0.2.3")).toThrow("signature_invalid");
  expect(() => verifyManifest(bytes, signature, [pub], "0.2.4")).toThrow("version_mismatch");
  expect(() => verifyManifest(bytes, signature + "!", [pub])).toThrow("signature_invalid");
  expect(() => verifyArtifact(Buffer.from("a"), manifest.artifacts[0]!)).toThrow("digest_mismatch");
  expect(() => verifyArtifact(Buffer.alloc(0), manifest.artifacts[0]!)).toThrow("digest_mismatch");
});
test("PEM and base64 SPKI keys share the same fingerprint; other algorithms are rejected", () => {
  const base64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  expect(publicKeyPEM(base64)).toBe(pub);
  expect(keyFingerprint(base64)).toBe(keyFingerprint(pub));
  const rsa = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  expect(() => publicKeyPEM(rsa.publicKey.export({ type: "spki", format: "pem" }).toString())).toThrow();
});
test("unsigned fallback is confined to known versions below the first signed release line", () => {
  for (const version of ["0.1.6", "0.2.2", "0.2.1-rc.2"]) expect(permitsUnsignedRelease(version)).toBe(true);
  for (const version of ["0.2.3", "0.2.3-rc.1", "0.2.10", "0.3.0", "1.0.0", "0.2.2-dev.local.abc", "latest", "../../bad"]) expect(permitsUnsignedRelease(version)).toBe(false);
});
