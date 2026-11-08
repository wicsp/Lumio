import { dirname, join, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
export class NativeError extends Error {
    readonly code = "INVALID";
    constructor(readonly reason: string) { super(reason); }
}
/** Deny-by-default outer boundary; the engine's command sandbox nests inside it. */
export function seatbelt(root: string, executable: string, extraReads: string[] = []): string {
    const quote = (s: string) => JSON.stringify(s);
    const reads = [root, ...extraReads, dirname(executable), resolve(dirname(executable), "../codex-resources"), "/System", "/usr", "/bin", "/sbin", "/private/etc", "/nix/store", "/private/var/db/dyld", "/Library/Apple"];
    return `(version 1)\n(deny default)\n(allow process*)\n(allow file-map-executable)\n(allow signal (target self) (target children))\n(allow sysctl-read)\n(allow mach-lookup)\n(allow ipc-posix*)\n(allow file-read-metadata)\n(allow file-read* (literal "/") ${reads.map(p => `(subpath ${quote(p)})`).join(" ")} (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))\n(allow file-write* (subpath ${quote(root)}) (literal "/dev/null"))\n(allow network-outbound)\n(allow network-inbound (local ip "localhost:*"))\n`;
}
export async function codexExecutable(configured?: string): Promise<string> {
    const found = configured ?? Bun.which("codex");
    if (!found)
        throw new NativeError("native.codex_missing");
    const path = await realpath(found);
    if (!path.endsWith(".js"))
        return path;
    const candidate = resolve(dirname(path), "../node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex");
    if (await stat(candidate).catch(() => undefined))
        return candidate;
    throw new NativeError("native.executable_required");
}
export function isolatedEnvironment(root: string, home: string, executable: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    // No host API keys, proxy redirection, shell hooks, or runtime bearer token.
    return { PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(executable)}`, HOME: root, CODEX_HOME: home, TMPDIR: join(root, "tmp"), SHELL: "/bin/sh", LANG: "en_US.UTF-8", TERM: "dumb",
        ...(source.SSL_CERT_FILE?.startsWith("/nix/store/") ? { SSL_CERT_FILE: source.SSL_CERT_FILE } : {}) };
}
export function sandboxCommand(root: string, executable: string, extraReads: string[] = []): string[] {
    if (process.platform !== "darwin")
        throw new NativeError("native.isolation_unsupported");
    return ["/usr/bin/sandbox-exec", "-p", seatbelt(root, executable, extraReads), executable];
}
