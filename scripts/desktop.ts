import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const appName = "Lumio Capture.app";
const identityName = "Lumio Capture Development";

function command(argv: string[], options: { quiet?: boolean; stdin?: Uint8Array } = {}): string {
  const result = Bun.spawnSync(argv, { stdout: options.quiet ? "pipe" : "inherit", stderr: "pipe", ...(options.stdin ? { stdin: options.stdin } : {}) });
  if (!result.success) throw new Error(`${argv[0]} failed: ${result.stderr.toString().trim() || result.exitCode}`);
  if (!options.quiet && result.stderr.length) process.stderr.write(result.stderr);
  return options.quiet ? result.stdout?.toString().trim() ?? "" : "";
}

function identity(): string | undefined {
  const desired = process.env.LUMIO_DESKTOP_SIGN_IDENTITY?.trim() || identityName;
  const identities = command(["security", "find-identity", "-v", "-p", "codesigning"], { quiet: true });
  const matching = [...identities.matchAll(/^\s*\d+\) ([0-9A-F]{40}) "(.+)"\s*$/gm)]
    .filter(match => match[1] === desired.toUpperCase() || match[2] === desired);
  if (matching.length > 1) throw new Error("Select one signing identity by setting LUMIO_DESKTOP_SIGN_IDENTITY to its certificate fingerprint.");
  return matching[0]?.[1];
}

function createIdentity(work: string) {
  if (identity()) { console.log("The desktop signing identity is already available."); return; }
  if (process.env.LUMIO_DESKTOP_SIGN_IDENTITY) throw new Error("Clear LUMIO_DESKTOP_SIGN_IDENTITY to create the default local identity.");
  const keychain = command(["security", "default-keychain", "-d", "user"], { quiet: true }).replace(/^"|"$/g, "");
  if (!keychain) throw new Error("A default user Keychain is required.");
  const config = join(work, "openssl.cnf"), key = join(work, "key.pem"), certificate = join(work, "cert.pem"), bundle = join(work, "identity.p12");
  const existing = command(["security", "find-identity", "-p", "codesigning"], { quiet: true });
  if (existing.includes(`"${identityName}"`)) {
    writeFileSync(certificate, command(["security", "find-certificate", "-c", identityName, "-p", keychain], { quiet: true }) + "\n", { mode: 0o600 });
  } else {
    writeFileSync(config, `[req]
distinguished_name = name
prompt = no
x509_extensions = code_signing
[name]
CN = ${identityName}
[code_signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
`, { mode: 0o600 });
    command(["/usr/bin/openssl", "req", "-new", "-x509", "-nodes", "-newkey", "rsa:3072", "-sha256", "-days", "3650",
      "-config", config, "-keyout", key, "-out", certificate], { quiet: true });
    chmodSync(key, 0o600);
    const password = randomBytes(32).toString("hex");
    command(["/usr/bin/openssl", "pkcs12", "-export", "-inkey", key, "-in", certificate, "-out", bundle, "-passout", "stdin"],
      { quiet: true, stdin: Buffer.from(password + "\n") });
    command(["security", "import", bundle, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"], { quiet: true });
    rmSync(key);
    rmSync(bundle);
  }
  command(["security", "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, certificate], { quiet: true });
  if (!identity()) throw new Error("The imported development certificate is not trusted for code signing.");
  console.log("Created the Lumio Capture Development signing identity.");
}

function swift(action: "build" | "test", scratch: string, extra: string[] = [], quiet = false) {
  return command(["swift", action, "--package-path", root, "--scratch-path", scratch, ...extra], { quiet });
}

function assemble(work: string, signing: string): string {
  const release = ["-c", "release"];
  swift("build", join(work, "swift"), release);
  const binaryDir = swift("build", join(work, "swift"), [...release, "--show-bin-path"], true);
  const app = join(work, appName), contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  command(["cp", join(root, "Info.plist"), join(contents, "Info.plist")]);
  command(["cp", join(binaryDir, "LumioCapture"), join(contents, "MacOS", "LumioCapture")]);
  command(["codesign", "--force", "--timestamp=none", "--options", "runtime", "--entitlements", join(root, "Entitlements.plist"), "--sign", signing, app]);
  verify(app);
  return app;
}

function verify(app: string) {
  command(["codesign", "--verify", "--strict", "--deep", app]);
}

async function stopInstalled(target: string) {
  const search = Bun.spawnSync(["pgrep", "-U", String(process.getuid!()), "-x", "LumioCapture"]);
  if (search.exitCode !== 0 && search.exitCode !== 1) throw new Error("Could not check whether Lumio Capture is running.");
  const binary = join(target, "Contents/MacOS/LumioCapture");
  const matches = search.stdout.toString().trim().split("\n").filter(value => /^\d+$/.test(value));
  for (const pid of matches) {
    const running = () => {
      const current = Bun.spawnSync(["ps", "-ww", "-p", pid, "-o", "comm="]);
      return current.success && current.stdout.toString().trim() === binary;
    };
    if (!running()) continue;
    try { process.kill(Number(pid), "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    for (let attempt = 0; attempt < 30 && running(); attempt++) await Bun.sleep(100);
    if (running()) throw new Error("Could not stop the installed Lumio Capture.");
  }
}

async function install(app: string) {
  const applications = join(homedir(), "Applications"), target = join(applications, appName);
  mkdirSync(applications, { recursive: true });
  const stage = mkdtempSync(join(applications, ".lumio-capture-"));
  const next = join(stage, appName), previous = join(stage, "previous.app");
  let preservePrevious = false;
  try {
    command(["ditto", app, next]);
    verify(next);
    const current = existsSync(target);
    if (current) {
      await stopInstalled(target);
      renameSync(target, previous);
    }
    let activated = false;
    try {
      renameSync(next, target);
      activated = true;
      command(["open", "-g", target]);
    } catch (error) {
      if (activated) rmSync(target, { recursive: true });
      if (current) {
        preservePrevious = true;
        renameSync(previous, target);
        preservePrevious = false;
        command(["open", "-g", target]);
      }
      throw error;
    }
    console.log(`Installed ${target}`);
  } finally {
    if (!preservePrevious) rmSync(stage, { recursive: true, force: true });
  }
}

async function main() {
  const [action, option, ...rest] = Bun.argv.slice(2);
  if (rest.length || !["check", "build", "create-identity"].includes(action ?? "") || (option && (action !== "build" || option !== "--install"))) {
    throw new Error("Usage: bun run scripts/desktop.ts check | build [--install] | create-identity");
  }
  if (process.platform !== "darwin") {
    if (action === "check") { console.log("Desktop checks run on macOS."); return; }
    throw new Error("Desktop builds and signing run on macOS.");
  }
  const work = mkdtempSync(join(tmpdir(), "lumio-desktop-"));
  try {
    if (action === "check") {
      swift("build", join(work, "swift"));
      swift("test", join(work, "swift"));
    } else if (action === "create-identity") {
      createIdentity(work);
    } else {
      const signing = identity();
      if (!signing) throw new Error("Create a signing identity with bun run scripts/desktop.ts create-identity or set LUMIO_DESKTOP_SIGN_IDENTITY.");
      const app = assemble(work, signing);
      if (option === "--install") await install(app);
      else {
        const out = join(root, ".build", appName);
        mkdirSync(dirname(out), { recursive: true });
        rmSync(out, { recursive: true, force: true });
        command(["ditto", app, out]);
        verify(out);
        console.log(out);
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
}

process.umask(0o077);
try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : "Desktop build failed"); process.exitCode = 1; }
