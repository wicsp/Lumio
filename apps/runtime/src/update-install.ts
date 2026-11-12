import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { RuntimePlatform, type RuntimeInstall } from "@lumio/schema";
import { privateFile, runCommand, type RunCommand } from "./service.ts";

export const UPDATE_EXIT_CODE = 75;
export function updatePlatform(platform = process.platform, arch = process.arch): RuntimePlatform | undefined { return RuntimePlatform.safeParse(`${platform}-${arch}`).data; }
export async function detectInstall(options: { home?: string; binary?: string; compiled?: boolean; env?: NodeJS.ProcessEnv; platform?: string } = {}): Promise<RuntimeInstall> {
  const env = options.env ?? process.env, home = options.home ?? homedir(), binary = options.binary ?? process.execPath;
  if (env.LUMIO_RUNTIME_AUTO_UPDATE === "off" || !(options.compiled ?? Bun.main.startsWith("/$bunfs/")) || env.container || env.LUMIO_CONTAINER === "1") return "external";
  const expected = join(home, ".local/bin/lumio");
  try {
    if (!(await lstat(expected)).isFile() || await realpath(binary) !== await realpath(expected)) return "external";
    const platform = options.platform ?? process.platform;
    const service = platform === "darwin" ? join(home, "Library/LaunchAgents/io.lumio.hub.plist") : join(home, ".config/systemd/user/lumio-hub.service");
    try {
      const content = await readFile(service, "utf8");
      const command = platform === "darwin" ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(content)?.[1]?.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'")
        : /^ExecStart=(?:"([^"]+)"|(\S+))/m.exec(content)?.slice(1).find(Boolean)?.replaceAll("%%", "%");
      if (command && await realpath(command) === await realpath(expected)) return "hub-shared";
      return "external"; // A Hub service exists but its ownership/layout is ambiguous.
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return "external"; }
    if (await Bun.file("/.dockerenv").exists() || await Bun.file("/run/.containerenv").exists()) return "external";
    return "managed";
  } catch { return "external"; }
}
type Pending = { version: string; previousVersion: string; attempts: number };
export class UpdateInstall {
  readonly root: string;
  constructor(readonly stateDir: string, readonly binary: string) { this.root = join(stateDir, "update"); }
  private async atomic(source: string): Promise<void> {
    const temp = join(dirname(this.binary), `.lumio-update-${crypto.randomUUID()}`);
    try { await copyFile(source, temp); await chmod(temp, 0o755); await rename(temp, this.binary); }
    finally { await rm(temp, { force: true }); }
  }
  async replace(source: string, version: string, previousVersion: string): Promise<void> {
    if (!(await lstat(this.binary)).isFile()) throw new Error("Unsafe installation path");
    await mkdir(join(this.root, "previous"), { recursive: true, mode: 0o700 });
    await copyFile(this.binary, join(this.root, "previous/lumio"));
    await privateFile(join(this.root, "pending.json"), JSON.stringify({ version, previousVersion, attempts: 0 } satisfies Pending));
    try { await this.atomic(source); }
    catch (cause) { await rm(join(this.root, "pending.json"), { force: true }); throw cause; }
  }
  async confirm(version: string): Promise<void> {
    const pending = await this.pending();
    if (pending?.version === version) await rm(join(this.root, "pending.json"), { force: true });
  }
  private async pending(): Promise<Pending | undefined> {
    try {
      const p = JSON.parse(await readFile(join(this.root, "pending.json"), "utf8")) as Pending;
      if (!Number.isInteger(p.attempts) || p.attempts < 0 || typeof p.version !== "string" || typeof p.previousVersion !== "string") throw new Error("Invalid update marker");
      return p;
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; }
  }
  /** Run before opening any mutable queue/native state. Offline Hub starts do not consume attempts. */
  async startup(version: string, hubReachable: () => Promise<boolean>): Promise<boolean> {
    const pending = await this.pending();
    if (!pending) return false;
    if (version === pending.previousVersion) { await rm(join(this.root, "pending.json"), { force: true }); return false; }
    if (version !== pending.version || !await hubReachable()) return false;
    pending.attempts++;
    await privateFile(join(this.root, "pending.json"), JSON.stringify(pending));
    if (pending.attempts < 3) return false;
    await privateFile(join(this.root, "rollback.json"), JSON.stringify({ version: pending.version }));
    await this.atomic(join(this.root, "previous/lumio"));
    await rm(join(this.root, "pending.json"), { force: true });
    return true;
  }
}
/** The privileged helper is independently installed; a mismatched copy must be reinstalled by a human. */
export async function helperCompatible(command: string[], version: string, run: RunCommand = runCommand): Promise<boolean> {
  if (!command.length) return false;
  const marker = command.indexOf("--sudo-helper");
  const probe = marker > 0 ? [command[marker - 1]!, "--version"] : [...command, "--version"];
  try { const result = await run(probe); return result.code === 0 && result.stdout.trim().replace(/^v/, "") === version; }
  catch { return false; }
}
