import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseManifest, RUNTIME_PLATFORMS } from "@lumio/schema";
import { keyFingerprint, RELEASE_PUBLIC_KEYS, signManifest } from "@lumio/platform";

/** CI-only entry point. Never prints or writes the signing secret. */
export async function signRelease(directory: string, version: string, commit: string, privateKey: string): Promise<void> {
  if (!privateKey) throw new Error("LUMIO_RELEASE_SIGNING_KEY is required");
  const key = createPrivateKey(privateKey);
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  if (!RELEASE_PUBLIC_KEYS.some(value => keyFingerprint(value) === keyFingerprint(publicKey))) throw new Error("Release signing key does not match the compiled trust anchors");
  const artifacts = await Promise.all(RUNTIME_PLATFORMS.map(async platform => {
    const file = `lumio-${platform}.tar.gz`, bytes = await readFile(join(directory, file));
    return { platform, file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const manifest = ReleaseManifest.parse({ format: 1, version, commit, created: new Date().toISOString(), channel: "release", artifacts });
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const signature = signManifest(bytes, privateKey);
  await writeFile(join(directory, "manifest.json"), bytes);
  await writeFile(join(directory, "manifest.sig"), signature);
}
if (import.meta.main) {
  try {
    const [directory, version, commit] = process.argv.slice(2);
    if (!directory || !version || !commit) throw new Error("Usage: sign-release.ts <directory> <version> <commit>");
    await signRelease(directory, version, commit, process.env.LUMIO_RELEASE_SIGNING_KEY ?? "");
  } catch { console.error("Release signing failed: check the signing key, version, commit and artifacts"); process.exitCode = 1; }
}
