import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

/** Local execution cannot use the Knowledge directory as its working directory. */
export function workdirInVault(vault: string, workdir: string): boolean {
  const expanded = workdir === "~" ? homedir() : workdir.startsWith("~/") ? join(homedir(), workdir.slice(2)) : workdir;
  const inside = relative(resolve(vault), resolve(expanded));
  return !inside || (!inside.startsWith("..") && !inside.startsWith("/"));
}
