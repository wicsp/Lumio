import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildSigningKey, publishBuildUpdates } from "./build-updates.ts";

function run(argv: string[], options: { cwd?: string; stdin?: Uint8Array | Bun.BunFile } = {}): string {
  const result = Bun.spawnSync(argv, options);
  if (!result.success) throw new Error(`${argv[0]} failed: ${result.stderr.toString().trim() || result.exitCode}`);
  return result.stdout.toString().trim();
}

export function mioSsh(hostname?: string): string[] {
  if (hostname && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(hostname)) throw new Error("Invalid LUMIO_MIO_SSH_HOSTNAME");
  return ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=10",
    ...(hostname ? ["-o", `HostName=${hostname}`] : []), "mio"];
}

export async function deployMio(desktop: boolean) {
  if (desktop && process.platform !== "darwin") throw new Error("Lumio Capture builds require macOS.");
  const ssh = mioSsh(process.env.LUMIO_MIO_SSH_HOSTNAME);
  const onlineVersion = run([...ssh, "curl -fsS --max-time 5 http://127.0.0.1:17420/health"]).trim();
  const base = /^\d+\.\d+\.\d+/.exec(JSON.parse(onlineVersion).version)?.[0];
  if (!base) throw new Error("Mio did not report a valid installed version.");

  const git = (args: string[]) => run(["git", ...args], { cwd: import.meta.dir });
  git(["fetch", "--no-write-fetch-head", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const commit = git(["rev-parse", "refs/remotes/origin/main"]);
  const version = `${base}-dev.mio.${commit.slice(0, 7)}`;
  const work = mkdtempSync(join(tmpdir(), "lumio-mio-deploy."));
  const build = join(work, "source");
  try {
    run(["mkdir", build]);
    const archive = Bun.spawnSync(["git", "archive", commit], { cwd: import.meta.dir });
    if (!archive.success) throw new Error("Could not export origin/main.");
    run(["tar", "-xf", "-", "-C", build], { stdin: archive.stdout });
    const { packageManager } = JSON.parse(readFileSync(join(build, "package.json"), "utf8"));
    if (packageManager !== `bun@${Bun.version}`) throw new Error(`Use ${packageManager} to deploy this commit.`);
    console.log(`Building ${version} from origin/main.`);
    run([process.execPath, "install", "--frozen-lockfile"], { cwd: build });
    const candidate = join(work, "lumio");
    const compile = (platform: string, outfile: string) =>
      run([process.execPath, "run", "apps/cli/src/build-binary.ts", "--target", `bun-${platform}`, "--version", version, "--outfile", outfile], { cwd: build });
    compile("linux-x64", candidate);
    const signing = await buildSigningKey(join(homedir(), ".config/lumio/build-signing"));
    console.log(`Runtime build signing fingerprint: ${signing.fingerprint}`);
    await publishBuildUpdates({
      root: join(work, "updates"), build, version, commit, key: signing.privateKey, platforms: ["darwin-arm64"],
      compile: async (platform, outfile) => { compile(platform, outfile); },
      run: async (argv) => { run(argv); },
    });

    const bundle = join(work, "deploy.tar.gz");
    run(["tar", "-czf", bundle, "-C", work, "lumio", "updates"]);
    const digest = run(["shasum", "-a", "256", bundle]).split(/\s+/, 1)[0]!;
    const stage = run([...ssh, "umask 077; mktemp -d /var/lib/lumio-mio-trial-staging/deploy.XXXXXXXX"]);
    if (!/^\/var\/lib\/lumio-mio-trial-staging\/deploy\.[a-zA-Z0-9]+$/.test(stage)) throw new Error("Unexpected staging path on Mio.");
    console.log(`Mio deployment and backup: ${stage}`);
    run([...ssh, `cat > ${stage}/deploy.tar.gz`], { stdin: Bun.file(bundle) });
    const remoteScript = Bun.file(join(import.meta.dir, "deploy-mio.sh"));
    console.log(run([...ssh, `bash -s -- ${stage} ${version} ${digest}`], { stdin: remoteScript }));
    if (desktop) {
      const result = Bun.spawnSync([process.execPath, "run", "desktop:build", "--install"], { cwd: build, stdout: "inherit", stderr: "inherit" });
      if (!result.success) throw new Error("Mio was deployed and verified. Lumio Capture installation failed.");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
