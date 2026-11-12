import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { RuntimeUpdateDirective, RuntimeUpdateReport, type RuntimeInstall, type RuntimePlatform, type RuntimeUpdateReason } from "@lumio/schema";
import { downloadRelease, DownloadLimitError, manifestArtifact, releasePublicKeys, releaseShim, ReleaseVerificationError, verifyArtifact, verifyManifest } from "@lumio/platform";
import { privateFile, runCommand, type RunCommand } from "./service.ts";
import { UpdateInstall } from "./update-install.ts";

interface State {
  report: RuntimeUpdateReport;
  target?: string;
  readyAt?: number;
  staged?: string;
  failed?: string;
  requests: string[];
}
export interface SelfUpdateOptions {
  stateDir: string; version: string; platform: RuntimePlatform; install: RuntimeInstall; binary: string;
  url: string; token: string; home?: string; fetch?: typeof fetch; run?: RunCommand; keys?: readonly string[];
  now?: () => number; restart: () => void;
  beforeSwitch?: (version: string) => Promise<boolean>;
}
/** One background preparation at a time; the polling loop owns all switch decisions. */
export class SelfUpdate {
  private state: State;
  private directive?: RuntimeUpdateDirective;
  private flight?: Promise<void>;
  private generation = 0;
  private negotiated = false;
  private switching = false;
  private force = false;
  private blockedKeys?: string;
  private saving = Promise.resolve();
  readonly install: UpdateInstall;
  constructor(private options: SelfUpdateOptions) {
    this.install = new UpdateInstall(options.stateDir, options.binary);
    this.state = { report: { state: "current", since: this.time() }, requests: [] };
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private time() { return new Date(this.now()).toISOString(); }
  private async save(): Promise<void> {
    const bytes = JSON.stringify(this.state);
    this.saving = this.saving.catch(() => {}).then(() => privateFile(join(this.install.root, "state.json"), bytes));
    await this.saving;
  }
  async open(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(join(this.install.root, "state.json"), "utf8")) as State;
      RuntimeUpdateReport.parse(saved.report);
      if (!Array.isArray(saved.requests) || saved.requests.some(id => typeof id !== "string")) throw new Error("Invalid request history");
      this.state = saved;
      // Reverify staged bytes on every process start; paths in state are never executable authority.
      delete this.state.staged; delete this.state.readyAt;
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    try {
      const rollback = JSON.parse(await readFile(join(this.install.root, "rollback.json"), "utf8")) as { version: string };
      this.state.failed = rollback.version; this.state.target = rollback.version;
      this.report("failed", "confirm_failed"); await this.save();
      await rm(join(this.install.root, "rollback.json"), { force: true });
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  resetNegotiation(): void { this.negotiated = false; }
  heartbeat(): RuntimeUpdateReport | undefined { return this.negotiated ? this.state.report : undefined; }
  get draining(): boolean { return this.switching || !!this.directive && !this.directive.hold && this.state.report.state === "draining"; }
  get restarting(): boolean { return this.switching; }
  private report(state: RuntimeUpdateReport["state"], reason?: RuntimeUpdateReason): void {
    if (this.state.report.state === state && this.state.report.target === (state === "current" ? undefined : this.state.target) && this.state.report.reason === reason) return;
    this.state.report = RuntimeUpdateReport.parse({ state, since: this.time(), target: state === "current" ? undefined : this.state.target, reason });
  }
  async reconcile(input: RuntimeUpdateDirective | undefined, busy: () => boolean): Promise<void> {
    if (this.switching) return;
    this.directive = input ? RuntimeUpdateDirective.parse(input) : undefined;
    if (input) this.negotiated = true;
    if (!input) { this.generation++; this.force = false; this.report("current"); return; }
    if (this.state.target !== input.version) {
      this.generation++; this.force = false;
      this.state.target = input.version; delete this.state.staged; delete this.state.readyAt; delete this.state.failed;
      this.report("current"); await this.save();
    }
    for (const kind of ["retry", "restart_now"] as const) {
      const id = input[kind];
      if (!id || this.state.requests.includes(id)) continue;
      this.state.requests.push(id); await this.save(); // Durable before carrying out the action.
      if (kind === "retry") { delete this.state.failed; this.generation++; this.report("current"); }
      else this.force = true;
    }
    if (input.version === this.options.version) { this.report("current"); await this.save(); return; }
    if (this.options.install === "external") { this.report("blocked", "external_install"); await this.save(); return; }
    if (this.state.failed === input.version) {
      if (this.state.report.reason !== "untrusted_build") return;
      const keys = await this.buildKeysText();
      if (keys === this.blockedKeys) return;
      this.blockedKeys = keys; delete this.state.failed;
    }
    if (input.hold) { this.force = false; if (this.state.staged) this.report("staged"); await this.save(); return; }
    if (!this.state.staged) {
      if (!this.flight) {
        const generation = this.generation;
        this.report("downloading"); await this.save();
        this.flight = this.prepare(input.version, generation).finally(() => { this.flight = undefined; });
      }
      return;
    }
    if (busy() && !this.force) {
      this.report(this.now() - this.state.readyAt! >= 30 * 60_000 ? "draining" : "waiting_idle"); await this.save(); return;
    }
    // Freeze local admission before any awaited filesystem operation. Native admission shares this gate.
    this.switching = true;
    this.report("restarting"); await this.save();
    try {
      if (this.options.beforeSwitch && !await this.options.beforeSwitch(input.version)) {
        this.switching = false; this.force = false; this.report("staged"); await this.save(); return;
      }
      if (this.options.install === "managed") await this.install.replace(this.state.staged, input.version, this.options.version);
      this.options.restart();
    } catch {
      this.switching = false; this.state.failed = input.version; this.report("failed", "replace_failed"); await this.save();
    }
  }
  private async prepare(version: string, generation: number): Promise<void> {
    try {
      let source: string;
      if (this.options.install === "hub-shared") {
        const result = await (this.options.run ?? runCommand)([this.options.binary, "--version"]);
        if (result.code || result.stdout.trim().replace(/^v/, "") !== version) {
          // Hub may have changed desired version before its deployment has atomically replaced the disk file.
          if (generation === this.generation) this.report("waiting_idle");
          return;
        }
        source = this.options.binary;
      } else source = await this.download(version);
      if (generation !== this.generation || this.directive?.version !== version) return;
      this.state.staged = source; this.state.readyAt = this.now(); this.report("staged"); await this.save();
    } catch (cause) {
      if (generation !== this.generation) return;
      const reason = cause instanceof ReleaseVerificationError ? cause.reason : "download_failed";
      if (reason === "untrusted_build") this.blockedKeys = await this.buildKeysText();
      this.state.failed = version;
      this.report(reason === "untrusted_build" ? "blocked" : "failed", reason); await this.save();
    }
  }
  private async buildKeysText(): Promise<string | undefined> {
    try { return await readFile(join(this.options.home ?? homedir(), ".config/lumio-runtime/trusted-build-keys.json"), "utf8"); } catch { return undefined; }
  }
  private async download(version: string): Promise<string> {
    const fetcher = this.options.fetch ?? fetch;
    const dev = version.includes("-dev.");
    let trusted: string[] = [];
    try { trusted = JSON.parse(await readFile(join(this.options.home ?? homedir(), ".config/lumio-runtime/trusted-build-keys.json"), "utf8")) as string[]; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new ReleaseVerificationError("untrusted_build"); }
    if (!Array.isArray(trusted) || trusted.some(value => typeof value !== "string")) throw new ReleaseVerificationError("untrusted_build");
    if (dev && !trusted.length) throw new ReleaseVerificationError("untrusted_build");
    const keys = dev ? trusted : this.options.keys ?? releasePublicKeys;
    const sources = [{ base: `${this.options.url}/v2/execution/updates/${version}`, auth: true },
      ...(!dev ? [{ base: `https://github.com/wicsp/Lumio/releases/download/v${version}`, auth: false }] : [])];
    let last: unknown;
    let archive: Buffer | undefined;
    for (const source of sources) {
      // Never forward the Runtime token to GitHub, or follow authenticated redirects.
      const transport = ((input, init) => fetcher(input, { ...init, redirect: source.auth ? "error" : "follow",
        ...(source.auth ? { headers: { Authorization: `Bearer ${this.options.token}` } } : {}) })) as typeof fetch;
      try {
        const bytes = await downloadRelease(`${source.base}/manifest.json`, { fetch: transport, maxBytes: 64 * 1024 });
        const sig = await downloadRelease(`${source.base}/manifest.sig`, { fetch: transport, maxBytes: 256 });
        const manifest = verifyManifest(bytes, sig.toString("utf8"), keys, version);
        const artifact = manifestArtifact(manifest, this.options.platform);
        archive = await downloadRelease(`${source.base}/${artifact.file}`, { fetch: transport, maxBytes: artifact.size }); verifyArtifact(archive, artifact);
        break;
      } catch (cause) {
        // An authenticated-but-tampered Hub must not be silently masked by a successful fallback.
        if (cause instanceof DownloadLimitError) throw new ReleaseVerificationError("digest_mismatch");
        if (cause instanceof ReleaseVerificationError) throw cause;
        last = cause;
      }
    }
    if (!archive) throw last ?? new ReleaseVerificationError("artifact_unavailable");
    const root = join(this.install.root, "staged"); await mkdir(root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(root)) await rm(join(root, name), { recursive: true, force: true });
    const directory = join(root, version), tar = join(root, "package.tar.gz");
    await mkdir(directory, { mode: 0o700 }); await writeFile(tar, archive, { mode: 0o600 });
    const run = this.options.run ?? runCommand;
    const command = async (argv: string[]) => { const result = await run(argv); if (result.code) throw new ReleaseVerificationError("preflight_failed"); return result.stdout; };
    try {
      const names = (await command(["tar", "-tzf", tar])).trim().split("\n"), types = (await command(["tar", "-tvzf", tar])).trim().split("\n");
      if (names.length !== 3 || ["lumio", "lumio-hub", "lumio-runtime"].some(name => names.filter(value => value === name).length !== 1) || types.length !== 3 || types.some(line => !line.startsWith("-"))) throw new ReleaseVerificationError("preflight_failed");
      await command(["tar", "-xzf", tar, "-C", directory]);
      for (const name of names) { const stat = await lstat(join(directory, name)); if (!stat.isFile() || stat.nlink !== 1) throw new ReleaseVerificationError("preflight_failed"); }
      for (const role of ["hub", "runtime"] as const) if (!(await readFile(join(directory, `lumio-${role}`))).equals(Buffer.from(releaseShim(role)))) throw new ReleaseVerificationError("preflight_failed");
      const binary = join(directory, "lumio"); await chmod(binary, 0o755);
      if ((await command([binary, "--version"])).trim().replace(/^v/, "") !== version) throw new ReleaseVerificationError("version_mismatch");
      await command([binary, "runtime", "update-check", "--state-dir", this.options.stateDir]);
      return binary;
    } finally { await rm(tar, { force: true }); }
  }
  async prepared(): Promise<void> { await this.flight; }
  async close(): Promise<void> { this.generation++; await this.flight; await this.saving; }
}
