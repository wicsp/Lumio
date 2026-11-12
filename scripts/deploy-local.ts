import { Database } from "bun:sqlite";
import { buildSigningKey, managedPlatforms, publishBuildUpdates } from "./build-updates.ts";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const hubUrl = "http://127.0.0.1:7420";


function output(command: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: Uint8Array }): string {
  const result = Bun.spawnSync(command, options);
  if (!result.success) throw new Error(`${command[0]} failed: ${result.stderr.toString().trim() || result.exitCode}`);
  return result.stdout.toString().trim();
}

export function fileIdentity(path: string): string {
  const { dev, ino, size, mtimeMs, ctimeMs } = lstatSync(path);
  return JSON.stringify([dev, ino, size, mtimeMs, ctimeMs]);
}

function stageBinary(from: string, folder: string): string {
  const stage = join(folder, "lumio");
  copyFileSync(from, stage);
  chmodSync(stage, 0o755);
  return stage;
}

/** Stage both files on the installation filesystem. Rename only fully checked files. */
export async function replaceBinary(options: {
  installed: string;
  candidate: string;
  previous: string;
  originalIdentity: string;
  verify: (staged: string) => void;
  activate: () => Promise<void>;
  rollback: () => Promise<void>;
}): Promise<void> {
  const staging = mkdtempSync(join(dirname(options.installed), ".lumio-deploy."));
  try {
    const next = stageBinary(options.candidate, staging);
    options.verify(next);
    const old = join(staging, "previous");
    copyFileSync(options.previous, old);
    chmodSync(old, 0o755);
    if (fileIdentity(options.installed) !== options.originalIdentity) {
      throw new Error("Installed Lumio changed during preparation. Coordinate with the other deployment and retry.");
    }
    renameSync(next, options.installed);
    const deployedIdentity = fileIdentity(options.installed);
    try {
      await options.activate();
      if (fileIdentity(options.installed) !== deployedIdentity) throw new Error("Installed Lumio changed during activation.");
    } catch (failure) {
      if (fileIdentity(options.installed) !== deployedIdentity) throw failure;
      try {
        renameSync(old, options.installed);
        await options.rollback();
        console.error("Previous Lumio restored.");
      } catch (rollbackFailure) {
        throw new AggregateError([failure, rollbackFailure], "Activation and rollback failed. See the deployment backup.");
      }
      throw failure;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function readOnly<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try { return read(db); }
  finally { db.close(); }
}

export function assertHubIdle(hubDb: string) {
  const turns = readOnly(hubDb, db => db.query<{ count: number }, []>("SELECT count(*) AS count FROM assistant_turns WHERE status='running'").get()!.count);
  if (turns) throw new Error(`Wait for ${turns} active Hub assistant turns before deployment.`);
}

export function snapshotDatabase(source: string, target: string) {
  const before = fileIdentity(source);
  try {
    readOnly(source, db => {
      db.exec("PRAGMA busy_timeout=5000");
      db.query("VACUUM INTO ?").run(target);
    });
  } catch (error) {
    // An inactive WAL-mode database can fail to open read-only without its sidecars.
    // A stable main file with no sidecars can be copied and verified independently.
    const sidecars = ["-wal", "-shm", "-journal"].map(suffix => source + suffix);
    if (!(error instanceof Error) || !("code" in error) || !String(error.code).startsWith("SQLITE_CANTOPEN")
        || sidecars.some(existsSync) || fileIdentity(source) !== before) throw error;
    copyFileSync(source, target);
    if (sidecars.some(existsSync) || fileIdentity(source) !== before) throw error;
  }
  chmodSync(target, 0o600);
  const copy = new Database(target);
  try {
    const rows = copy.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
    if (rows.length !== 1 || rows[0]?.quick_check !== "ok") throw new Error(`Invalid Runtime database snapshot: ${target}`);
  } finally { copy.close(); }
}

function backupRuntime(source: string, target: string) {
  mkdirSync(target);
  output(["/usr/bin/rsync", "-rlpt", "--exclude=*.sock", "--exclude=*.sqlite", "--exclude=*.sqlite-*", source + "/", target + "/"]);
  function snapshotFolder(from: string, to: string) {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) snapshotFolder(join(from, entry.name), join(to, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".sqlite") && entry.name !== ".business-writer.sqlite") {
        mkdirSync(to, { recursive: true });
        snapshotDatabase(join(from, entry.name), join(to, entry.name));
      }
    }
  }
  snapshotFolder(source, target);
}

function plistValue(plist: string, key: string): string {
  return output(["/usr/libexec/PlistBuddy", "-c", `Print :${key}`, plist]);
}

function servicePid(service: string): number | undefined {
  const status = Bun.spawnSync(["launchctl", "print", service]);
  if (status.success) {
    const pid = status.stdout.toString().match(/^\s+pid = (\d+)$/m)?.[1];
    return pid ? Number(pid) : undefined;
  }
}

function restartService(domain: string, role: string, plist: string) {
  const service = `${domain}/io.lumio.${role}`;
  if (Bun.spawnSync(["launchctl", "print", service]).success) output(["launchctl", "kickstart", "-k", service]);
  else output(["launchctl", "bootstrap", domain, plist]);
}

async function verifyWeb(version: string, hubService: string, oldPid: number | undefined) {
  const curl = (path: string, flags: string[] = []) => output([
    "/usr/bin/curl", "--noproxy", "*", "--fail", "--silent", "--show-error", "--max-time", "3", ...flags, hubUrl + path,
  ]);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const pid = servicePid(hubService);
      const health = JSON.parse(curl("/health")) as { ok?: boolean; version?: string };
      if (pid && pid !== oldPid && health.ok === true && health.version === version) {
        for (const [path, mime] of [["/", "text/html"], ["/assets/app.js", "text/javascript"], ["/assets/app.css", "text/css"]] as const) {
          const [status, content, bytes] = curl(path, ["--output", "/dev/null", "--write-out", "%{http_code}\n%{content_type}\n%{size_download}"]).split("\n");
          if (status !== "200" || !content?.startsWith(mime) || !(Number(bytes) > 0)) throw new Error(`Unexpected response for ${path}`);
        }
        return;
      }
    } catch { /* Wait for launchd to finish bringing the Hub up. */ }
    await Bun.sleep(1000);
  }
  throw new Error(`Hub ${version} did not serve a healthy homepage, JavaScript and CSS on 7420.`);
}

async function verifyRuntime(hubDb: string, name: string, service: string, since: number, version: string) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const row = readOnly(hubDb, db => {
      const runtime = db.query<{ last_seen: string; registration: string }, [string]>("SELECT last_seen,registration FROM runtimes WHERE name=?").get(name);
      const report = db.query<{ record: string }, [string]>("SELECT record FROM runtime_updates WHERE actor=(SELECT actor FROM runtimes WHERE name=?)").get(name);
      return { runtime, report };
    });
    const registration = row.runtime && JSON.parse(row.runtime.registration);
    const report = row.report && JSON.parse(row.report.record).report;
    const supports = registration?.features?.includes("self_update");
    if (servicePid(service) && row.runtime && Date.parse(row.runtime.last_seen) > since &&
      (!supports || registration.version === version || report?.target === version)) {
      if (!supports) console.log(`Runtime ${name} requires a one-time manual upgrade to enable self_update.`);
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Runtime ${name} did not acknowledge the desired version after deployment.`);
}
function reportRuntimeUpdates(hubDb: string) {
  const rows = readOnly(hubDb, db => db.query<{ name: string; registration: string; record: string | null }, []>("SELECT r.name,r.registration,u.record FROM runtimes r LEFT JOIN runtime_updates u ON u.actor=r.actor ORDER BY r.name").all());
  for (const row of rows) {
    const registration = JSON.parse(row.registration), update = row.record && JSON.parse(row.record);
    console.log(`${row.name}: ${registration.version ?? "unknown"} (${registration.install ?? "legacy"}), ${update?.policy ?? "follow"}, ${update?.report?.state ?? "waiting for heartbeat"}${update?.report?.reason ? `: ${update.report.reason}` : ""}`);
  }
}

async function deploy() {
  if (process.platform !== "darwin" || process.getuid?.() === 0) throw new Error("Run this on macsp as the Lumio LaunchAgent owner.");
  const repo = output(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir });
  const git = (args: string[]) => output(["git", ...args], { cwd: repo });
  const home = homedir();
  const installed = join(home, ".local/bin/lumio");
  const agents = join(home, "Library/LaunchAgents");
  const hubPlist = join(agents, "io.lumio.hub.plist");
  const runtimePlist = join(agents, "io.lumio.runtime.plist");
  if (plistValue(hubPlist, "EnvironmentVariables:LUMIO_HUB_LISTEN") !== "127.0.0.1:7420") {
    throw new Error("This script deploys the existing 127.0.0.1:7420 instance.");
  }
  for (const [plist, role] of [[hubPlist, "hub"], [runtimePlist, "runtime"]] as const) {
    if (plistValue(plist, "ProgramArguments:0") !== installed || plistValue(plist, "ProgramArguments:1") !== role
        || plistValue(plist, "ProgramArguments:2") !== "serve" || readlinkSync(join(dirname(installed), `lumio-${role}`)) !== "lumio") {
      throw new Error(`Unexpected ${role} install layout; expected the unified lumio executable.`);
    }
  }
  if (!lstatSync(installed).isFile()) throw new Error("Expected a regular unified lumio executable.");
  const hubState = plistValue(hubPlist, "EnvironmentVariables:LUMIO_STATE_DIR");
  const hubDb = join(hubState, "hub.sqlite");
  const runtimeState = plistValue(runtimePlist, "EnvironmentVariables:LUMIO_RUNTIME_STATE_DIR");
  const runtimeName = plistValue(runtimePlist, "EnvironmentVariables:LUMIO_RUNTIME_NAME");
  const domain = `gui/${process.getuid!()}`;
  const hubService = `${domain}/io.lumio.hub`;
  const runtimeService = `${domain}/io.lumio.runtime`;
  const backups = join(hubState, "deploy-backups");
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const lock = join(backups, ".deploy-7420.lock");
  try { mkdirSync(lock); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`7420 deployment lock exists at ${lock}. Check the other deployment before retrying.`);
    }
    throw error;
  }

  let build: string | undefined;
  try {
    const originalIdentity = fileIdentity(installed);
    const previousVersion = output([installed, "--version"]);
    assertHubIdle(hubDb);
    git(["fetch", "--no-write-fetch-head", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    const commit = git(["rev-parse", "refs/remotes/origin/main"]);

    build = mkdtempSync(join(tmpdir(), "lumio-7420."));
    const archive = Bun.spawnSync(["git", "archive", commit], { cwd: repo });
    if (!archive.success) throw new Error("Could not export main.");
    output(["tar", "-xf", "-", "-C", build], { stdin: archive.stdout });
    const { packageManager } = JSON.parse(readFileSync(join(build, "package.json"), "utf8")) as { packageManager: string };
    if (packageManager !== `bun@${Bun.version}`) throw new Error(`Use ${packageManager} to deploy this commit.`);
    const versionBase = previousVersion.match(/^\d+\.\d+\.\d+/)?.[0] ?? "0.0.0";
    const version = `${versionBase}-dev.local.${commit.slice(0, 7)}`;
    const candidate = join(build, "lumio");
    console.log(`Building ${version} from origin/main.`);
    output([process.execPath, "install", "--frozen-lockfile"], { cwd: build });
    output([process.execPath, "run", "apps/cli/src/build-binary.ts", "--version", version, "--outfile", candidate], { cwd: build });
    const verify = (path: string) => {
      output(["codesign", "--verify", "--strict", path]);
      if (output([path, "--version"]) !== version) throw new Error("Staged version does not match origin/main.");
    };
    verify(candidate);
    const registrations = readOnly(hubDb, db => db.query<{ registration: string }, []>("SELECT registration FROM runtimes").all().map(row => JSON.parse(row.registration)));
    const platforms = managedPlatforms(registrations);
    const signing = await buildSigningKey(join(home, ".config/lumio/build-signing"));
    console.log(`Build signing public key: ${join(home, ".config/lumio/build-signing/public.pem")}`);
    console.log(`Build signing SHA-256 fingerprint: ${signing.fingerprint}`);
    await publishBuildUpdates({ root: join(hubState, "updates"), build, version, commit, previous: previousVersion, key: signing.privateKey, platforms,
      compile: async (platform, outfile) => {
        if (platform === "darwin-arm64") copyFileSync(candidate, outfile);
        else output([process.execPath, "run", "apps/cli/src/build-binary.ts", "--target", `bun-${platform}`, "--version", version, "--outfile", outfile], { cwd: build });
      }, run: async argv => { output(argv); } });
    assertHubIdle(hubDb);

    const backup = mkdtempSync(join(backups, `main-${commit.slice(0, 7)}-`));
    console.log(`Deployment backup: ${backup}`);
    const business = join(backup, "business");
    output([candidate, "hub", "backup", "business", business], { env: { ...process.env, LUMIO_STATE_DIR: hubState } });
    output([candidate, "hub", "backup", "verify", business]);
    const previous = join(backup, "lumio");
    for (const [source, target] of [[installed, previous], [hubPlist, join(backup, "io.lumio.hub.plist")],
      [runtimePlist, join(backup, "io.lumio.runtime.plist")]] as const) {
      copyFileSync(source, target);
      chmodSync(target, target === previous ? 0o700 : 0o600);
    }
    const hubConfig = join(backup, "hub-config");
    mkdirSync(hubConfig);
    for (const name of ["config.json", "capture-proxy.json", "push-vapid.pem"]) {
      const source = join(hubState, name);
      if (!existsSync(source) || !lstatSync(source).isFile()) continue;
      const target = join(hubConfig, name);
      copyFileSync(source, target);
      chmodSync(target, 0o600);
    }
    backupRuntime(runtimeState, join(backup, "runtime"));
    assertHubIdle(hubDb);
    const activate = async (expected: string) => {
      const oldHubPid = servicePid(hubService);
      restartService(domain, "hub", hubPlist);
      await verifyWeb(expected, hubService, oldHubPid);
      await verifyRuntime(hubDb, runtimeName, runtimeService, Date.now(), expected);
    };
    await replaceBinary({ installed, candidate, previous, originalIdentity, verify,
      activate: () => activate(version), rollback: () => activate(previousVersion) });
    console.log(`Verified ${version} on ${hubUrl}; Runtime updates continue in the background.`);
    reportRuntimeUpdates(hubDb);
  } finally {
    if (build) rmSync(build, { recursive: true, force: true });
    rmdirSync(lock);
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun run scripts/deploy-local.ts [--allow-active]");
  } else if (args.length > 1 || (args.length === 1 && args[0] !== "--allow-active")) {
    console.error("Usage: bun run scripts/deploy-local.ts [--allow-active]");
    process.exitCode = 2;
  } else {
    process.umask(0o077);
    try { if (args.length) console.log("--allow-active is no longer needed: deployment always leaves Runtime running."); await deploy(); }
    catch (error) { console.error(error); process.exitCode = 1; }
  }
}
