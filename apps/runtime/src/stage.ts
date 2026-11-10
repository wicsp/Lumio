import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { StagePermissions } from "@lumio/schema";

/** Discover only Git metadata bound to this checkout. Ignore process Git overrides. */
export function gitWritePaths(workdir: string, env: NodeJS.ProcessEnv): string[] {
  const git = Bun.which("git", { PATH: env.PATH ?? "" });
  if (!git) return [];
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  const query = (...args: string[]) => {
    const result = Bun.spawnSync([git, "-C", workdir, "rev-parse", ...args], {
      env: gitEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000,
    });
    if (result.exitCode !== 0) throw new Error("git metadata is unavailable");
    return realpathSync(result.stdout.toString().trim());
  };
  try {
    const root = query("--show-toplevel");
    // A Git grant can never open a parent checkout outside the declared working directory.
    if (root !== realpathSync(workdir)) return [];
    const marker = join(root, ".git");
    const dir = query("--absolute-git-dir"), common = query("--path-format=absolute", "--git-common-dir");
    const type = lstatSync(marker);
    if (type.isDirectory() && marker === common && common === dir) return [common];
    if (type.isFile() && basename(common) === ".git" && dirname(dir) === join(common, "worktrees")
      && resolve(dir, readFileSync(join(dir, "gitdir"), "utf8").trim()) === marker) return [common, dir];
  } catch { /* Fail closed when there is no supported checkout. */ }
  return [];
}

export function codexGitOptions(paths: readonly string[], readOnly: boolean, network: boolean): string[] {
  const name = "lumio-stage";
  const filesystem = paths.map(path => `${JSON.stringify(path)}="write"`);
  if (paths.length === 1) filesystem.push('":workspace_roots"={".git"="write"}');
  else filesystem.push(`${JSON.stringify(join(paths[0]!, "worktrees"))}="read"`);
  // CLI config keys split on dots, including quoted path segments. Pass the whole TOML table.
  const profile = `{extends="${readOnly ? ":read-only" : ":workspace"}",network={enabled=${network}},filesystem={${filesystem.join(",")}}}`;
  return ["-c", `default_permissions="${name}"`, "-c", `permissions.${name}=${profile}`];
}

/** Stage secrets are named local Runtime variables and never enter the job specification. */
export function stageSecrets(permissions: StagePermissions | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  const values: NodeJS.ProcessEnv = {};
  for (const name of permissions?.secrets ?? []) {
    // Uppercase H is not a valid character in a SecretName; this encoding is reversible.
    const key = `LUMIO_SECRET_${name.replaceAll("-", "H")}`, value = env[key];
    if (!value) return;
    values[key] = value;
  }
  return values;
}

export function stageId(prompt: string): string | undefined {
  return /^Lumio stage ID: ([a-z][a-z0-9-]{0,31})\r?\n/.exec(prompt)?.[1];
}
