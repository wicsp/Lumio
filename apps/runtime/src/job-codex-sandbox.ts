import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export type JobGitToolchain = { executable: string; readPaths: string[] };

/** Expose a system Git binary, without exposing profile directories or the operator's config. */
export function jobGitToolchain(env: NodeJS.ProcessEnv): JobGitToolchain | undefined {
  try {
    const found = Bun.which("git", { PATH: env.PATH ?? "" });
    const executable = found && realpathSync(found);
    // Seatbelt already allows the immutable Nix store.
    if (executable?.startsWith("/nix/store/")) return { executable, readPaths: [] };
  } catch { /* Try Apple's toolchain. */ }

  try {
    const result = Bun.spawnSync(["/usr/bin/xcrun", "--no-cache", "--find", "git"], {
      env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" },
      stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3000,
    });
    if (result.exitCode !== 0) return;
    const executable = realpathSync(result.stdout.toString().trim());
    if (!/^\/(?:Library\/Developer\/CommandLineTools|Applications\/[^/]+[.]app\/Contents\/Developer)\/usr\/bin\/git$/.test(executable)) return;
    const usr = dirname(dirname(executable));
    return { executable, readPaths: [executable, join(usr, "share/git-core"), join(usr, "libexec/git-core")] };
  } catch { return; }
}

const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;

export function codexJobFilesystem(cwd: string, sessionRoot: string, writable: boolean, gitPaths: string[]): string {
  const rules: string[] = [];
  if (writable) rules.push(`(allow file-write* ${subpath(cwd)})`);
  const gitExceptions = gitPaths.map(path => `(require-not ${subpath(path)})`);
  for (const path of gitPaths) rules.push(`(allow file-write* ${subpath(path)})`);
  if (gitPaths.length && writable) {
    // A new linked checkout needs a .git pointer file in its worktree. It
    // does not need to create or modify another repository's .git directory.
    gitExceptions.push(`(require-not (require-all ${subpath(cwd)} (regex #"/[.][gG][iI][tT]$") (vnode-type REGULAR-FILE) (require-not (literal ${JSON.stringify(join(cwd, ".git"))}))))`);
  }
  rules.push(`(deny file-write* (require-all (regex #"/[.][gG][iI][tT](/|$)") ${gitExceptions.join(" ")}))`);
  if (gitPaths.length === 2) {
    // The common Git directory holds refs and objects as well as each sibling's index.
    rules.push(`(deny file-write* (require-all ${subpath(join(gitPaths[0]!, "worktrees"))} (require-not ${subpath(gitPaths[1]!)})))`);
  }
  rules.push(`(deny file-write* (require-all ${subpath(cwd)} (regex #"/[.]([aA][gG][eE][nN][tT][sS]|[cC][oO][dD][eE][xX]|[aA][wW][sS])(/|$)")))`);
  const codexHome = join(sessionRoot, "codex");
  // Only the engine's files and its temporary directory need to be writable.
  // Keep the Runtime's session lease read-only and prevent edits to Codex startup policy.
  rules.push(`(deny file-write* (require-all ${subpath(sessionRoot)} (require-not ${subpath(codexHome)}) (require-not ${subpath(join(sessionRoot, "tmp"))})))`);
  rules.push(`(deny file-write-unlink (literal ${JSON.stringify(codexHome)}))`);
  rules.push(`(deny file-write* (literal ${JSON.stringify(join(codexHome, "config.toml"))}) ${subpath(join(codexHome, "rules"))})`);
  return rules.join("\n") + "\n";
}
