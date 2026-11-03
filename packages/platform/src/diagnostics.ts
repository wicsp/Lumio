import { type Text, untranslated } from "./language.ts";
import { allowsColor, terminalColors, type TerminalOutput } from "./terminal.ts";
import { PlatformError } from "./errors.ts";
import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";

export interface Check { name: string; ok: boolean; warning?: boolean; problem?: string; fix?: string }
export interface CommandResult { code: number; stdout: string; stderr: string }
export interface DiagnosticOptions {
  text?: Text;
  find?: (name: string) => string | null;
  home?: string; env?: NodeJS.ProcessEnv; platform?: string; uid?: number;
  read?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ mode: number; uid: number; isFile(): boolean; isDirectory(): boolean }>;
  run?: (argv: string[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>;
  fetch?: typeof globalThis.fetch;
}
export function diagnosticIO(options: DiagnosticOptions = {}) {
  const env = options.env ?? process.env;
  return { text: options.text ?? untranslated, find: options.find ?? ((name: string) => Bun.which(name)), env, home: options.home ?? env.HOME ?? homedir(), platform: options.platform ?? process.platform,
    uid: options.uid ?? process.getuid?.() ?? -1,
    read: options.read ?? ((path: string) => readFile(path, "utf8")), stat: options.stat ?? lstat,
    run: options.run ?? (async (argv: string[], commandEnv?: NodeJS.ProcessEnv) => {
      const child = Bun.spawn(argv, { env: commandEnv ?? env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    }),
    fetch: timedFetch(options.fetch),
  };
}
export function timedFetch(fetcher = globalThis.fetch, remaining: () => number = () => 10_000): typeof globalThis.fetch {
  const request = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => fetcher(input, { ...init, redirect: init?.redirect ?? "error", signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining())))]) });
  return Object.assign(request, { preconnect: fetcher.preconnect });
}
export function httpURL(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new PlatformError("INVALID", { key: "diagnostics.invalid_http_s_url", args: [] }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new PlatformError("INVALID", { key: "diagnostics.invalid_http_s_url", args: [] });
  return url;
}
export function localAddress(url: URL): boolean {
  return ["localhost", "[::1]"].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
}
export function environment(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new PlatformError("INVALID", { key: "diagnostics.could_not_parse_environment_file", args: [] });
    let value = m[2]!;
    if (value.startsWith('"')) {
      if (!value.endsWith('"')) throw new PlatformError("INVALID", { key: "diagnostics.could_not_parse_environment_file", args: [] });
      value = value.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new PlatformError("INVALID", { key: "diagnostics.could_not_parse_environment_file", args: [] });
      value = value.slice(1, -1);
    }
    result[m[1]!] = value;
  }
  return result;
}
/** ok means no failure; optional reminders remain compatible with existing JSON consumers. */
export function checkStatus(check: Check): "pass" | "warning" | "fail" {
  return !check.ok ? "fail" : check.warning ? "warning" : "pass";
}
export function printChecks(checks: Check[], json: boolean, log: (line: string) => void,
  options: { output?: TerminalOutput; env?: NodeJS.ProcessEnv; text?: Text } = {}): number {
  const msg = options.text ?? untranslated;
  const colors = terminalColors(allowsColor(options.output ?? process.stdout, options.env));
  const counts = { pass: 0, warning: 0, fail: 0 };
  for (const check of checks) counts[checkStatus(check)]++;
  if (json) log(JSON.stringify(checks));
  else {
    for (const item of checks) {
      const status = checkStatus(item);
      const symbol = status === "pass" ? colors.green("✓") : status === "warning" ? colors.yellow("!") : colors.red("✗");
      log(`${symbol} ${item.name}${item.problem ? `：${item.problem}` : ""}${item.fix ? ` → ${item.fix}` : ""}`);
    }
    const color = counts.fail ? colors.red : counts.warning ? colors.yellow : colors.green;
    log(color(msg("${0} passed, ${1} warnings, ${2} failed", counts.pass, counts.warning, counts.fail)));
  }
  return counts.fail ? 1 : 0;
}
export function serviceCommand(platform: string, uid: number, service: "hub" | "runtime", action: "status" | "restart") {
  if (platform === "darwin") return ["launchctl", ...(action === "status" ? ["print"] : ["kickstart", "-k"]), `gui/${uid}/io.lumio.${service}`];
  if (platform === "linux") return ["systemctl", "--user", ...(action === "status" ? ["is-active", "--quiet"] : ["restart"]), `lumio-${service}.service`];
  throw new PlatformError("INVALID", { key: "setup.only_macos_and_linux_are_supported", args: [] });
}
