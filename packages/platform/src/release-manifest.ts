import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { ReleaseManifest, type ReleaseArtifact, type RuntimePlatform, type RuntimeUpdateReason } from "@lumio/schema";
import { RELEASE_PUBLIC_KEYS } from "./release-keys.ts";

declare const LUMIO_RELEASE_PUBLIC_KEYS: readonly string[];
export const releasePublicKeys: readonly string[] = typeof LUMIO_RELEASE_PUBLIC_KEYS === "undefined" ? RELEASE_PUBLIC_KEYS : LUMIO_RELEASE_PUBLIC_KEYS;
export const FIRST_SIGNED_RELEASE = "0.2.3";
export class ReleaseVerificationError extends Error {
  readonly code = "RELEASE_VERIFICATION_FAILED";
  constructor(readonly reason: RuntimeUpdateReason) { super(reason); }
}
export function publicKeyPEM(input: string): string {
  const key = input.includes("-----BEGIN") ? createPublicKey(input) : createPublicKey({ key: Buffer.from(input.trim(), "base64"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") throw new ReleaseVerificationError("signature_invalid");
  return key.export({ type: "spki", format: "pem" }).toString();
}
export function keyFingerprint(input: string): string {
  return createHash("sha256").update(createPublicKey(publicKeyPEM(input)).export({ type: "spki", format: "der" })).digest("hex");
}
export function signManifest(bytes: Uint8Array, privateKey: string): string {
  ReleaseManifest.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new ReleaseVerificationError("signature_invalid");
  return sign(null, bytes, key).toString("base64") + "\n";
}
/** Verify the original bytes before interpreting any release metadata. Keys are caller-owned trust. */
export function verifyManifest(bytes: Uint8Array, signature: string, keys: readonly string[] = releasePublicKeys, version?: string): ReleaseManifest {
  const encoded = signature.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) throw new ReleaseVerificationError("signature_invalid");
  const sig = Buffer.from(encoded, "base64");
  if (!keys.some(key => { try { return verify(null, bytes, publicKeyPEM(key), sig); } catch { return false; } })) throw new ReleaseVerificationError("signature_invalid");
  let manifest: ReleaseManifest;
  try { manifest = ReleaseManifest.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))); }
  catch { throw new ReleaseVerificationError("signature_invalid"); }
  if (version !== undefined && manifest.version !== version) throw new ReleaseVerificationError("version_mismatch");
  return manifest;
}
export function manifestArtifact(manifest: ReleaseManifest, platform: RuntimePlatform): ReleaseArtifact {
  const artifact = manifest.artifacts.find(item => item.platform === platform);
  if (!artifact) throw new ReleaseVerificationError("platform_missing");
  return artifact;
}
export function verifyArtifact(bytes: Uint8Array, artifact: ReleaseArtifact): void {
  if (bytes.byteLength !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new ReleaseVerificationError("digest_mismatch");
}
/** Only a known target older than the signing boundary can use the legacy checksum format. */
export function permitsUnsignedRelease(version: string, boundary = FIRST_SIGNED_RELEASE): boolean {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || /-dev\./.test(version)) return false;
  const left = version.split("-")[0]!.split(".").map(BigInt), right = boundary.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) { if (left[i]! < right[i]!) return true; if (left[i]! > right[i]!) return false; }
  // Signing is mandatory for the entire first signed release line, including its prereleases.
  return false;
}
