import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";

/** Local execution cannot use the Knowledge directory as its working directory. */
export function workdirInVault(vault: string, workdir: string): boolean {
  const expanded = workdir === "~" ? homedir() : workdir.startsWith("~/") ? join(homedir(), workdir.slice(2)) : workdir;
  const inside = relative(resolve(vault), resolve(expanded));
  return !inside || (!inside.startsWith("..") && !inside.startsWith("/"));
}

const canonical = (path: string): string => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

/** The local Runtime shares a filesystem with the Hub. Interactive access must exclude both private trees. */
function interactiveWorkdirOverlaps(workdir: string, privateDirectory: string): boolean {
  const expanded = workdir === "~" ? homedir() : workdir.startsWith("~/") ? join(homedir(), workdir.slice(2)) : workdir;
  const fold = (path: string) => process.platform === "darwin" ? path.toLowerCase() : path;
  const workspace = fold(canonical(expanded)), resource = fold(canonical(privateDirectory));
  const inside = (root: string, target: string) => {
    const part = relative(root, target);
    return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  };
  return inside(workspace, resource) || inside(resource, workspace);
}

export function requireLocalInteractiveWorkdir(config: Pick<HubConfig, "localRuntime" | "stateDir" | "vault">, runtime: string, workdir: string): void {
  if (runtime !== config.localRuntime) return;
  if ((config.vault && interactiveWorkdirOverlaps(workdir, config.vault)) || interactiveWorkdirOverlaps(workdir, config.stateDir)) {
    throw new HubError("INVALID", { key: "jobs.interactive_private_workdir", args: [] });
  }
}
