/** Fixed release-only wrappers accepted by v0.1.x upgraders as ordinary executables.
 * New installers validate these exact UTF-8 bytes, then install links instead.
 */
export function releaseShim(role: "hub" | "runtime"): string {
  return `#!/bin/sh\nexec "$(dirname "$0")/lumio" ${role} "$@"\n`;
}
