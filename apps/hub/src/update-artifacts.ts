import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LumioVersion } from "@lumio/schema";
import { downloadRelease, verifyArtifact, verifyManifest, type releasePublicKeys } from "@lumio/platform";
import type { Identity } from "./store.ts";
import { HubError } from "./errors.ts";

const missing = () => new HubError("NOT_FOUND", { key: "server.endpoint_not_found", args: [] });
/** Runtime-only artifact cache. Development signatures remain the Runtime's trust decision. */
export class UpdateArtifacts {
  private previous?: string;
  private ready?: Promise<void>;
  private flights = new Map<string, Promise<void>>();
  readonly root: string;
  constructor(stateDir: string, readonly version: string, private options: { fetch?: typeof fetch; keys?: typeof releasePublicKeys; releaseBase?: string } = {}) { this.root = join(stateDir, "updates"); }
  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      try {
        const saved = JSON.parse(await readFile(join(this.root, "versions.json"), "utf8")) as { current: string; previous?: string };
        const old = saved.current === this.version ? saved.previous : saved.current;
        this.previous = LumioVersion.safeParse(old).data;
      } catch { /* First cache use. */ }
      const stage = join(this.root, `.versions-${crypto.randomUUID()}`);
      await writeFile(stage, JSON.stringify({ current: this.version, previous: this.previous }), { mode: 0o600 });
      await rename(stage, join(this.root, "versions.json"));
      for (const name of await readdir(this.root)) if (LumioVersion.safeParse(name).success && name !== this.version && name !== this.previous) await rm(join(this.root, name), { recursive: true, force: true });
    })();
  }
  private async cache(version: string): Promise<void> {
    const directory = join(this.root, version);
    try { if ((await lstat(join(directory, "manifest.json"))).isFile()) return; } catch { /* Download release. */ }
    if (version.includes("-dev")) throw missing();
    let flight = this.flights.get(version);
    if (!flight) {
      flight = (async () => {
        const stage = join(this.root, `.download-${crypto.randomUUID()}`);
        await mkdir(stage, { mode: 0o700 });
        try {
          const base = `${this.options.releaseBase ?? "https://github.com/wicsp/Lumio/releases/download"}/v${version}`;
          const fetcher = this.options.fetch ?? fetch;
          const bytes = await downloadRelease(`${base}/manifest.json`, { fetch: fetcher, maxBytes: 64 * 1024 });
          const sig = await downloadRelease(`${base}/manifest.sig`, { fetch: fetcher, maxBytes: 256 });
          const manifest = verifyManifest(bytes, sig.toString("utf8"), this.options.keys, version);
          if (manifest.channel !== "release") throw missing();
          await writeFile(join(stage, "manifest.json"), bytes, { mode: 0o600 });
          await writeFile(join(stage, "manifest.sig"), sig, { mode: 0o600 });
          for (const artifact of manifest.artifacts) {
            const archive = await downloadRelease(`${base}/${artifact.file}`, { fetch: fetcher, maxBytes: artifact.size }); verifyArtifact(archive, artifact);
            await writeFile(join(stage, artifact.file), archive, { mode: 0o600 });
          }
          await rename(stage, directory);
        } finally { await rm(stage, { recursive: true, force: true }); }
      })().finally(() => this.flights.delete(version));
      this.flights.set(version, flight);
    }
    await flight;
  }
  async handle(request: Request, identity: Identity): Promise<Response> {
    if (identity.actor.role !== "runtime") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
    const parts = new URL(request.url).pathname.split("/");
    const version = parts[4], file = parts[5];
    if (request.method !== "GET" || parts.length !== 6 || !LumioVersion.safeParse(version).success ||
      !/^(manifest\.(json|sig)|lumio-(darwin-arm64|linux-x64|linux-arm64)\.tar\.gz)$/.test(file ?? "")) throw missing();
    await this.initialize();
    if (version !== this.version && version !== this.previous) throw missing();
    try {
      await this.cache(version!);
      const directory = join(this.root, version!), path = join(directory, file!);
      if (!(await lstat(directory)).isDirectory() || !(await lstat(path)).isFile()) throw missing();
      return new Response(Bun.file(path), { headers: { "Cache-Control": "private, no-store", "Content-Type": file === "manifest.json" ? "application/json" : "application/octet-stream" } });
    } catch { throw missing(); }
  }
}
