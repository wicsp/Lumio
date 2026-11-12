import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseManifest, LumioVersion, RuntimeRegistration, type RuntimePlatform } from "../packages/schema/src/index.ts";
import { keyFingerprint, releaseShim, signManifest, verifyManifest } from "../packages/platform/src/index.ts";

export function managedPlatforms(registrations: unknown[]): RuntimePlatform[] {
  return [...new Set(registrations.map(value => RuntimeRegistration.parse(value)).filter(value => value.install === "managed" && value.features?.includes("self_update")).map(value => value.platform!))].sort();
}
export async function buildSigningKey(directory: string): Promise<{ privateKey: string; publicKey: string; fingerprint: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const file = join(directory, "private.pem");
  let privateKey: string;
  try {
    if (!(await lstat(file)).isFile()) throw new Error("Build signing key must be a regular file");
    privateKey = await readFile(file, "utf8"); await chmod(file, 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await writeFile(file, privateKey, { mode: 0o600, flag: "wx" });
  }
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const fingerprint = keyFingerprint(publicKey);
  await writeFile(join(directory, "public.pem"), publicKey, { mode: 0o600 });
  return { privateKey, publicKey, fingerprint };
}
/** Exported for synthetic tests; caller owns the deployment lock and supplies a build command. */
export async function publishBuildUpdates(options: {
  root: string; build: string; version: string; commit: string; previous?: string; key: string; platforms: RuntimePlatform[];
  compile: (platform: RuntimePlatform, outfile: string) => Promise<void>;
  run: (argv: string[]) => Promise<void>;
}): Promise<void> {
  const version = LumioVersion.parse(options.version), root = options.root;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, version), stage = join(root, `.publish-${crypto.randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const artifacts = [];
    for (const platform of options.platforms) {
      const build = join(options.build, `update-${platform}`); await mkdir(build, { recursive: true, mode: 0o700 });
      await options.compile(platform, join(build, "lumio"));
      for (const role of ["hub", "runtime"] as const) await writeFile(join(build, `lumio-${role}`), releaseShim(role), { mode: 0o755 });
      const file = `lumio-${platform}.tar.gz`;
      await options.run(["tar", "-czf", join(stage, file), "-C", build, "lumio", "lumio-hub", "lumio-runtime"]);
      const bytes = await readFile(join(stage, file));
      artifacts.push({ platform, file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    if (artifacts.length) {
      const manifest = ReleaseManifest.parse({ format: 1, version, channel: "dev", commit: options.commit, created: new Date().toISOString(), artifacts });
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), signature = signManifest(bytes, options.key);
      verifyManifest(bytes, signature, [createPublicKey(options.key).export({ type: "spki", format: "pem" }).toString()], version);
      await writeFile(join(stage, "manifest.json"), bytes, { mode: 0o600 }); await writeFile(join(stage, "manifest.sig"), signature, { mode: 0o600 });
      try { await rename(stage, directory); }
      catch (cause) {
        if (!["ENOTEMPTY", "EEXIST"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
        // An existing version is immutable. Re-deploying it must not replace bytes in flight.
        const existing = verifyManifest(await readFile(join(directory, "manifest.json")), await readFile(join(directory, "manifest.sig"), "utf8"), [createPublicKey(options.key).export({ type: "spki", format: "pem" }).toString()], version);
        if (existing.commit !== options.commit || options.platforms.some(platform => !existing.artifacts.some(artifact => artifact.platform === platform))) throw new Error("Existing build version has different artifacts; deploy a new commit");
      }
    }
    const previous = options.previous && options.previous !== version ? LumioVersion.parse(options.previous) : undefined;
    const index = join(root, `.versions-${crypto.randomUUID()}`);
    await writeFile(index, JSON.stringify({ current: version, previous }), { mode: 0o600 }); await rename(index, join(root, "versions.json"));
    for (const name of await readdir(root)) if (LumioVersion.safeParse(name).success && name !== version && name !== previous) await rm(join(root, name), { recursive: true, force: true });
  } finally { await rm(stage, { recursive: true, force: true }); }
}
