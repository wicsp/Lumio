import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeBackgroundResult, type ClaudeQuotaIssue } from "@lumio/schema";
import { NativeProcessScope } from "./process-scope.ts";
import { isolatedEnvironment, seatbelt } from "./isolation.ts";
import { ClaudeQuotaScreen } from "./claude-quota-screen.ts";

const supportedVersion = "2.1.322 (Claude Code)";
const signature = 'anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"';
const flags = ["--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--tools", "", "--no-chrome", "--settings", '{"disableAllHooks":true,"remoteControlAtStartup":false}'];
const managedDirectory = "/Library/Application Support/ClaudeCode";
const failure = (issue: ClaudeQuotaIssue): ClaudeBackgroundResult => ({ status: "failed", issue });

class ProbeError extends Error {
  constructor(readonly issue: ClaudeQuotaIssue) { super(issue); }
}

function fingerprint(email: string | undefined, organization: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return;
  return createHash("sha256").update(JSON.stringify([normalized, organization?.trim().toLowerCase() ?? ""])).digest("hex");
}

function statusIdentity(screen: string): string | undefined {
  const email = /^\s*(?:Account email|Email)\s*:\s*([^\s]+)\s*$/im.exec(screen)?.[1];
  const organization = /^\s*Organization\s*:\s*(.+)$/im.exec(screen)?.[1];
  return fingerprint(email, organization);
}

function resetTime(value: string | undefined, now: Date): string | undefined {
  if (!value) return;
  const iso = /\b(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d))\b/.exec(value)?.[1];
  if (iso && Date.parse(iso) > now.getTime()) return new Date(iso).toISOString();
  const m = /(?:\b([A-Za-z]{3})\s+(\d{1,2}),?\s+)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\((?:UTC|Etc\/UTC)\)\s*$/i.exec(value);
  if (!m) return;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = m[1] ? months.indexOf(m[1].toLowerCase()) : now.getUTCMonth();
  const day = m[2] ? Number(m[2]) : now.getUTCDate();
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || (m[5] && (hour < 1 || hour > 12))) return;
  if (m[5]) hour = hour % 12 + (m[5].toLowerCase() === "pm" ? 12 : 0);
  let date = new Date(Date.UTC(now.getUTCFullYear(), month, day, hour, minute));
  if (date.getUTCDate() !== day) return;
  if (date.getTime() <= now.getTime()) {
    if (m[1]) date.setUTCFullYear(date.getUTCFullYear() + 1);
    else date.setUTCDate(date.getUTCDate() + 1);
  }
  if (date.getTime() - now.getTime() <= 7 * 24 * 60 * 60_000) return date.toISOString();
}

export function parseClaudeUsage(screen: string, now = new Date()): Extract<ClaudeBackgroundResult, { status: "ready" }>["windows"] {
  const lines = screen.split("\n").map(line => line.trim());
  const windows: Extract<ClaudeBackgroundResult, { status: "ready" }>["windows"] = [];
  for (const [id, minutes, title] of [
    ["five_hour", 300, /^Current session$/i],
    ["seven_day", 10080, /^Current week(?:\s*\(all models\))?$/i],
  ] as const) {
    const index = lines.findIndex(line => title.test(line));
    if (index < 0) continue;
    const rows: string[] = [];
    for (const line of lines.slice(index + 1, index + 6)) {
      if (/^(?:Current (?:session|week)|Usage credits|Extra usage)\b/i.test(line)) break;
      rows.push(line);
    }
    const used = /\b(\d{1,3}(?:\.\d+)?)\s*%\s*used\b/i.exec(rows.join(" "));
    if (!used || Number(used[1]) > 100) continue;
    const reset = rows.find(line => /^Resets\b/i.test(line))?.replace(/^Resets(?:\s+at)?\s*/i, "");
    windows.push({ id, minutes, used_percent: Number(used[1]), resets_at: resetTime(reset, now) });
  }
  return windows;
}

/** Only submit a slash command after the official TUI exposes its built-in command description. */
class UsageConversation {
  private state: "prompt" | "status-menu" | "status" | "close-status" | "usage-menu" | "usage" = "prompt";
  private account?: string;

  constructor(account: string | undefined, private expected?: string) { this.account = account; }

  observe(screen: string, write: (text: string) => void): ClaudeBackgroundResult | undefined {
    if (/Quick safety check|Do you trust|Yes, I trust|trust this (?:folder|workspace|project|directory)/i.test(screen))
      return failure("trust_required");
    if (/Select (?:a )?login method|sign in to Claude|please (?:sign in|log in)|login required|usage is only available/i.test(screen))
      return failure("login_required");
    if (/rate limit(?:ed| exceeded)|too many requests|Usage data is currently unavailable.*429|HTTP 429/i.test(screen))
      return failure("rate_limited");
    if (/Press (?:Enter|Return) to continue|permission required|Allow this action\?/i.test(screen))
      return failure("unknown_layout");
    const prompt = /^\s*❯\s*(?:Try\s.+)?\s*$/m.test(screen);
    if (this.state === "prompt" && prompt) {
      if (this.account && this.expected && this.account !== this.expected) return failure("account_changed");
      this.state = this.account ? "usage-menu" : "status-menu";
      write(this.account ? "/usage" : "/status");
    } else if (this.state === "status-menu" && /^\s*(?:❯\s*)?\/?status\s+(?:Show|Display|View|Open|Set)\b.*(?:status|settings|account)/im.test(screen)) {
      this.state = "status";
      write("\r");
    } else if (this.state === "status" && /Login method\s*:|Settings\s*[:›].*Status|^\s*Version\s*:/im.test(screen)) {
      const account = statusIdentity(screen);
      if (!account) return;
      if (this.expected && account !== this.expected) return failure("account_changed");
      this.account = account;
      this.state = "close-status";
      write("\x1b");
    } else if (this.state === "close-status" && prompt && !/Login method\s*:/i.test(screen)) {
      this.state = "usage-menu";
      write("/usage");
    } else if (this.state === "usage-menu" && /^\s*(?:❯\s*)?\/?usage\s+(?:Show|Display|View|Open)\b.*(?:usage|limit|cost)/im.test(screen)) {
      this.state = "usage";
      write("\r");
    } else if (this.state === "usage" && this.account) {
      const windows = parseClaudeUsage(screen);
      if (windows.length) return { status: "ready", account: this.account, windows };
      if (/Failed to load usage|Unable to load usage|Usage data unavailable/i.test(screen)) return failure("unknown_layout");
    }
  }

  timeout(): ClaudeBackgroundResult {
    if (this.state === "status") return failure("account_unverified");
    if (this.state.endsWith("-menu")) return failure("unknown_layout");
    return failure("timeout");
  }
}

export async function runClaudeQuotaTerminal(
  argv: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
  account?: string, expected?: string, timeout = 18_000,
): Promise<ClaudeBackgroundResult> {
  if (signal.aborted) return failure("timeout");
  const screen = new ClaudeQuotaScreen();
  const conversation = new UsageConversation(account, expected);
  const { promise, resolve: finish } = Promise.withResolvers<ClaudeBackgroundResult>();
  let bytes = 0, settled = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const done = (result: ClaudeBackgroundResult) => {
    if (settled) return;
    settled = true;
    finish(result);
  };
  const child = Bun.spawn(argv, { cwd, env, terminal: {
    cols: screen.cols, rows: screen.rows,
    data(terminal, data) {
      if (settled) return;
      if ((bytes += data.byteLength) > 262_144) { done(failure("unknown_layout")); return; }
      try {
        screen.feed(data);
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          if (settled) return;
          try {
            const result = conversation.observe(screen.text(), input => terminal.write(input));
            if (result) done(ClaudeBackgroundResult.parse(result));
          } catch { done(failure("unknown_layout")); }
        }, 100);
      } catch { done(failure("unknown_layout")); }
    },
  } });
  const processScope = new NativeProcessScope(child.pid);
  const onAbort = () => done(failure("timeout"));
  const timer = setTimeout(() => done(conversation.timeout()), timeout);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  void child.exited.then(() => done(failure("unknown_layout")), () => done(failure("unknown_layout")));
  try { return await promise; }
  finally {
    clearTimeout(timer);
    clearTimeout(quiet);
    signal.removeEventListener("abort", onAbort);
    child.terminal?.close();
    const stopped = await processScope.stop();
    if (!stopped) throw new ProbeError("timeout");
    await child.exited.catch(() => {});
  }
}

async function shortCommand(argv: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]), killSignal: "SIGKILL" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "", size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { child.kill("SIGKILL"); throw new ProbeError("unknown_layout"); }
      output += decoder.decode(value, { stream: true });
    }
    return { code: await child.exited, output: output + decoder.decode() };
  } finally { reader.releaseLock(); await child.exited.catch(() => {}); }
}

async function probeEnvironment(stateDir: string, signal = new AbortController().signal) {
  if (process.platform !== "darwin") throw new ProbeError("version_unsupported");
  const home = userInfo().homedir;
  const root = join(await realpath(stateDir), "claude-quota");
  const cwd = join(root, "work"), config = join(root, "config");
  for (const path of [root, cwd, config, join(root, "tmp")]) {
    await mkdir(path, { mode: 0o700 }).catch(cause => { if (cause.code !== "EEXIST") throw cause; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new ProbeError("version_unsupported");
    await chmod(path, 0o700);
  }
  // GUI services can inherit terminal shims ahead of the official native installation.
  const installed = await realpath(join(home, ".local/bin/claude")).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT") throw new ProbeError("version_unsupported");
  });
  const found = installed ?? Bun.which("claude");
  if (!found) throw new ProbeError("version_unsupported");
  const executable = installed ?? await realpath(found).catch(() => { throw new ProbeError("version_unsupported"); });
  // macOS locates the user's login Keychain through HOME. Claude selects its
  // own separate credential entry through CLAUDE_CONFIG_DIR.
  const env = { ...isolatedEnvironment(root, root, executable), HOME: home, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(executable)}`,
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: join(root, "tmp"), TERM: "xterm-256color", TZ: "UTC", CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" };
  if ((await shortCommand(["/usr/bin/codesign", "--verify", "--strict", `-R=${signature}`, executable], cwd, env, signal)).code)
    throw new ProbeError("version_unsupported");
  const version = await shortCommand([executable, "--version"], cwd, env, signal);
  if (version.code || version.output.trim() !== supportedVersion) throw new ProbeError("version_unsupported");
  return { root, cwd, executable, env, loginKeychain: join(home, "Library/Keychains/login.keychain-db") };
}

export async function queryClaudeQuota(stateDir: string, signal: AbortSignal, expected?: string): Promise<ClaudeBackgroundResult> {
  try {
    const { root, cwd, executable, env, loginKeychain } = await probeEnvironment(stateDir, signal);
    for (const name of ["managed-settings.json", "managed-settings.d", "managed-mcp.json"]) {
      const present = await lstat(join(managedDirectory, name)).then(() => true, (e: NodeJS.ErrnoException) => e.code !== "ENOENT");
      if (present) return failure("version_unsupported");
    }
    // The official CLI delegates Keychain access to Apple's security tool.
    // Grant read access to the login database only, without opening its parent directory.
    const profile = seatbelt(root, executable, [managedDirectory]) +
      `(allow file-read* (literal ${JSON.stringify(loginKeychain)}))` +
      `(deny process-exec (require-not (require-any (literal ${JSON.stringify(executable)}) (literal "/usr/bin/security"))))`;
    const argv = ["/usr/bin/sandbox-exec", "-p", profile, executable, ...flags];
    const info = await shortCommand([...argv, "auth", "status"], cwd, env, signal);
    const auth = JSON.parse(info.output) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string;
      configDirectory?: string; email?: string; emailAddress?: string; orgId?: string; organizationId?: string; orgName?: string; organizationName?: string };
    if (info.code || !auth.loggedIn || auth.authMethod !== "claude.ai" || auth.apiProvider !== "firstParty") return failure("login_required");
    if (auth.configDirectory !== undefined && auth.configDirectory !== env.CLAUDE_CONFIG_DIR) return failure("account_unverified");
    const account = fingerprint(auth.email ?? auth.emailAddress, auth.orgId ?? auth.organizationId ?? auth.orgName ?? auth.organizationName);
    if (account && expected && account !== expected) return failure("account_changed");
    return await runClaudeQuotaTerminal(argv, cwd, env, signal, account, expected);
  } catch (cause) {
    return failure(cause instanceof ProbeError ? cause.issue : signal.aborted ? "timeout" : "unknown_layout");
  }
}

/** A foreground, user-invoked Anthropic sign-in. Never returns credentials to Lumio. */
export async function setupClaudeQuota(stateDir: string, trust: boolean): Promise<number> {
  const { cwd, executable, env } = await probeEnvironment(stateDir);
  return Bun.spawn([executable, ...flags, ...(trust ? [] : ["auth", "login"])], {
    cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  }).exited;
}
