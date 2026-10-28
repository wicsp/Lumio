import * as files from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { CliConfig, RuntimeName } from "@lumio/schema";
import { readConfig, isLoopback } from "./config.ts";
import { HubError } from "./errors.ts";
import { HubStore } from "./store.ts";

interface CommandResult { code: number; stdout: string; stderr: string }
type Run = (argv: string[]) => Promise<CommandResult>;
async function runCommand(argv: string[]): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 40_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}
export function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function unitString(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`; }
export function environmentText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => {
    if (/[\r\n\0]/.test(value)) throw new HubError("INVALID", "服务环境变量不能包含换行或 NUL");
    return `${key}="${value.replace(/[\\"$`]/g, "\\$&")}"`;
  }).join("\n") + "\n";
}
export function parseEnvironment(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/).map((line) => line.trim())) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new HubError("INVALID", "已有服务环境文件格式不合法");
    let value = match[2]!;
    if (value.startsWith('"')) {
      if (!value.endsWith('"')) throw new HubError("INVALID", "已有服务环境文件格式不合法");
      value = value.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    env[match[1]!] = value;
  }
  return env;
}
export function hubPlist(binary: string, env: Record<string, string>, state: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.lumio.hub</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(state, "hub.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, "hub.err.log"))}</string>
</dict></plist>\n`;
}
export function hubUnit(binary: string, envFile: string): string {
  return `[Unit]\nDescription=Lumio Hub\nAfter=network.target\n\n[Service]\nExecStart=${unitString(binary)}\nEnvironmentFile=${unitString(envFile)}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}
export function runtimeName(host: string): string {
  return RuntimeName.parse(host.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "local");
}
export interface SetupOptions {
  vault?: string; server?: boolean; yes?: boolean; home?: string; host?: string; platform?: string;
  binary?: string; runtimeBinary?: string; env?: NodeJS.ProcessEnv; uid?: number;
  run?: Run; find?: (program: string) => string | null; fetch?: (input: string, init?: RequestInit) => Promise<Response>; files?: typeof files;
  now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void;
  ask?: (question: string, fallback: string) => Promise<string>;
}
export async function setup(options: SetupOptions = {}): Promise<void> {
  const fs = options.files ?? files, env = options.env ?? process.env;
  const home = resolve(options.home ?? env.HOME ?? homedir());
  const host = options.host ?? hostname(), platform = options.platform ?? process.platform;
  const binary = options.binary ?? process.execPath, runtimeBinary = options.runtimeBinary ?? join(dirname(binary), "lumio-runtime");
  if (!["darwin", "linux"].includes(platform)) throw new HubError("INVALID", "只支持 macOS 与 Linux");
  if (![binary, runtimeBinary].every((path) => isAbsolute(path) && !/[\r\n]/.test(path))) throw new HubError("INVALID", "程序路径必须是绝对路径");
  const run = options.run ?? runCommand, find = options.find ?? ((program) => Bun.which(program));
  const log = options.log ?? console.log, fetcher = options.fetch ?? fetch;
  const ask = async (question: string, fallback: string) => {
    if (options.yes || (!options.ask && !process.stdin.isTTY)) return fallback;
    if (options.ask) return (await options.ask(question, fallback)).trim() || fallback;
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await input.question(`${question} [${fallback}]：`)).trim() || fallback; } finally { input.close(); }
  };
  async function optional(path: string) {
    try { return await fs.readFile(path, "utf8"); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
  }
  async function privateFile(path: string, content: string) {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await fs.chmod(dirname(path), 0o700);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 }); await fs.rename(temp, path); }
    finally { await fs.rm(temp, { force: true }); }
  }
  const configPath = join(home, ".config/lumio/config.json");
  const old = await optional(configPath);
  let previous: CliConfig | undefined;
  if (old) {
    try { previous = CliConfig.parse(JSON.parse(old)); }
    catch { throw new HubError("INVALID", "已有 CLI 配置无法解析，请先修复 config.json"); }
  }
  const defaultVault = join(home, ".config/lumio/vault");
  const chosenVault = options.vault ?? await ask("vault 路径", previous?.vault ?? defaultVault);
  const vault = chosenVault === "~" ? home : resolve(chosenVault.startsWith("~/") ? join(home, chosenVault.slice(2)) : chosenVault);
  try {
    if (!(await fs.stat(vault)).isDirectory()) throw new HubError("INVALID", "vault 必须是目录");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || vault !== defaultVault) throw new HubError("INVALID", "指定的 vault 目录不存在或无法读取");
    await fs.mkdir(vault, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(vault, "README.md"), "# Lumio vault\n\n这里存放 Markdown 笔记。目录结构见 https://github.com/wicsp/Lumio/blob/main/docs/DESIGN.md#31-vault-目录adr-0012 。可用任意编辑器打开。\n", { flag: "wx" });
  }
  const state = resolve(env.LUMIO_STATE_DIR ?? join(home, ".local/share/lumio"));
  await fs.mkdir(state, { recursive: true, mode: 0o700 }); await fs.chmod(state, 0o700);
  const envFile = join(home, ".config/lumio/hub.env");
  const previousEnv = parseEnvironment(await optional(envFile) ?? "");
  let listen = env.LUMIO_HUB_LISTEN ?? previousEnv.LUMIO_HUB_LISTEN ?? "127.0.0.1:7420";
  let publicUrl = env.LUMIO_PUBLIC_URL ?? previousEnv.LUMIO_PUBLIC_URL ?? "";
  if (options.server) {
    listen = await ask("监听地址", env.LUMIO_HUB_LISTEN ?? (previousEnv.LUMIO_PUBLIC_URL ? listen : "0.0.0.0:7420"));
    publicUrl = await ask("对外地址（如 https://lumio.example.org）", publicUrl);
  }
  const tailscale = find("tailscale");
  if (tailscale && (await ask("用 Tailscale 提供对外地址？yes/no", "no")) === "yes") {
    const mode = await ask("Tailscale 方式：serve / ip", "serve");
    const result = await run([tailscale, "status", "--json"]);
    let status: { Self?: { DNSName?: string; TailscaleIPs?: string[] } };
    try { if (result.code) throw new Error(); status = JSON.parse(result.stdout); }
    catch { throw new HubError("INVALID", "无法读取 Tailscale 状态，请检查是否已登录"); }
    const port = listen.slice(listen.lastIndexOf(":") + 1);
    if (mode === "serve") {
      const dns = status.Self?.DNSName?.replace(/\.$/, "");
      if (!dns || (await run([tailscale, "serve", "--bg", port])).code) throw new HubError("INVALID", "Tailscale serve 未能启动");
      publicUrl = `https://${dns}`;
      listen = `127.0.0.1:${port}`;
    } else if (mode === "ip") {
      const ip = status.Self?.TailscaleIPs?.find((ip) => !ip.includes(":"));
      if (!ip) throw new HubError("INVALID", "Tailscale 没有可用的 IPv4 地址");
      listen = `${ip}:${port}`; publicUrl = `http://${listen}`;
    } else throw new HubError("INVALID", "Tailscale 方式必须是 serve 或 ip");
  }
  const config = readConfig({ ...env, LUMIO_VAULT: vault, LUMIO_STATE_DIR: state, LUMIO_HUB_LISTEN: listen, LUMIO_PUBLIC_URL: publicUrl });
  if (!config.port) throw new HubError("INVALID", "setup 需要固定的非零端口");
  // For a binding to one interface, the local client must use that interface as well.
  const localHost = ["0.0.0.0", "::"].includes(config.hostname) ? "127.0.0.1" : config.hostname;
  const url = `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${config.port}`;
  if (publicUrl.startsWith("http://") && !isLoopback(new URL(publicUrl).hostname)) log("警告：对外地址使用 HTTP，令牌将以明文传输；请配置 HTTPS 反向代理。");
  const store = await HubStore.open(state);
  let token: string, runtimeToken: string;
  const name = runtimeName(host);
  try {
    let human = store.actors().find((actor) => actor.role === "human");
    human ??= store.createActor("owner", "human");
    const runtime = store.actors().find((actor) => actor.name === name);
    if (runtime && runtime.role !== "runtime") throw new HubError("CONFLICT", "本机执行器名称与已有非执行器身份冲突");
    const localRuntime = runtime ?? store.createActor(name, "runtime");
    for (const old of store.tokens()) if (old.actor_id === localRuntime.id && !old.revoked) store.revokeToken(old.label);
    token = store.replaceToken(`cli@${host}`, human.name);
    runtimeToken = store.replaceToken(`runtime@${name}`, name);
  } finally { store.close(); }
  await privateFile(configPath, JSON.stringify(CliConfig.parse({ hub_url: url, token, vault }), null, 2) + "\n");
  const serviceEnv = { ...previousEnv, LUMIO_VAULT: vault, LUMIO_STATE_DIR: state, LUMIO_HUB_LISTEN: listen,
    PATH: [...new Set([dirname(find("git") ?? "/usr/bin/git"), env.PATH ?? "/usr/bin:/bin"])].join(":"),
    ...(config.publicUrl ? { LUMIO_PUBLIC_URL: config.publicUrl } : {}),
  };
  if (!config.publicUrl) delete serviceEnv.LUMIO_PUBLIC_URL;
  if (env.LUMIO_TRUSTED_PROXY) Object.assign(serviceEnv, { LUMIO_TRUSTED_PROXY: env.LUMIO_TRUSTED_PROXY });
  await privateFile(envFile, environmentText(serviceEnv));
  let managed = true;
  if (platform === "darwin") {
    const path = join(home, "Library/LaunchAgents/io.lumio.hub.plist");
    await privateFile(path, hubPlist(binary, serviceEnv, state));
    if ((await run(["plutil", "-lint", path])).code) throw new HubError("INVALID", "Hub 服务配置校验失败");
    const domain = `gui/${options.uid ?? process.getuid!()}`;
    await run(["launchctl", "bootout", domain, path]);
    if ((await run(["launchctl", "bootstrap", domain, path])).code) throw new HubError("INVALID", `Hub 服务无法启动，请查看 ${state}/hub.err.log`);
  } else {
    const path = join(home, ".config/systemd/user/lumio-hub.service");
    await privateFile(path, hubUnit(binary, envFile));
    try { managed = (await run(["systemctl", "--user", "show-environment"])).code === 0; } catch { managed = false; }
    if (managed) {
      const active = (await run(["systemctl", "--user", "is-active", "--quiet", "lumio-hub.service"])).code === 0;
      for (const argv of [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "lumio-hub.service"], ...(active ? [["systemctl", "--user", "restart", "lumio-hub.service"]] : [])]) {
        if ((await run(argv)).code) throw new HubError("INVALID", "Hub 服务无法启动，请运行 journalctl --user -u lumio-hub -n 30");
      }
      let linger = "";
      try { linger = (await run(["loginctl", "show-user", env.USER ?? "", "-p", "Linger"])).stdout; } catch { /* hint below */ }
      if (!linger.includes("Linger=yes")) log(`退出登录后 Hub 会停止；请管理员运行 loginctl enable-linger ${env.USER ?? "<用户名>"}`);
    } else log(`没有 systemd 用户服务。手动运行：set -a; . '${envFile.replaceAll("'", "'\\''")}'; set +a; nohup '${binary.replaceAll("'", "'\\''")}' > '${state.replaceAll("'", "'\\''")}/hub.log' 2>&1 &（也可放入 crontab @reboot）。`);
  }
  if (managed) {
    const now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep, until = now() + 20_000;
    let ready = false;
    while (now() < until) {
      try {
        const health = await fetcher(`${url}/health`, { redirect: "error", signal: AbortSignal.timeout(1000) });
        if (health.ok && (await health.json() as { ok?: boolean }).ok) {
          const actors = await fetcher(`${url}/v1/actors`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(1000) });
          if (actors.ok) { ready = true; break; }
        }
      } catch { /* diagnose after the deadline */ }
      await sleep(500);
    }
    if (!ready) {
      const logPath = join(state, "hub.err.log");
      let errors = (await optional(logPath) ?? "").slice(-8192);
      if (platform === "linux") { try { errors += (await run(["journalctl", "--user", "-u", "lumio-hub", "-n", "30", "--no-pager"])).stdout; } catch { /* use log path */ } }
      if (/EPERM|EACCES|Operation not permitted/i.test(errors)) throw new HubError("INVALID", platform === "darwin" ? `系统设置 → 隐私与安全性 → 完全磁盘访问权限，加入 ${binary}，然后重新运行 lumio-hub setup` : `Hub 无法读取 vault；请检查目录权限。日志：${logPath}`);
      if (/EADDRINUSE|address already in use/i.test(errors)) throw new HubError("INVALID", `端口 ${config.port} 被占用；请停止占用程序或修改 LUMIO_HUB_LISTEN 后重新运行 setup`);
      throw new HubError("INVALID", `Hub 启动超时；日志：${platform === "linux" ? "journalctl --user -u lumio-hub -n 30" : logPath}`);
    }
  }
  const runtimeEnvFile = join(home, ".config/lumio-runtime/runtime.env");
  const runtimeEnv = { ...parseEnvironment(await optional(runtimeEnvFile) ?? ""), LUMIO_HUB_URL: url, LUMIO_TOKEN: runtimeToken,
    LUMIO_RUNTIME_NAME: name, LUMIO_RUNTIME_STATE_DIR: join(home, ".local/share/lumio-runtime"), PATH: env.PATH ?? "/usr/bin:/bin" };
  await privateFile(runtimeEnvFile, environmentText(runtimeEnv));
  const installed = await run([runtimeBinary, "install-service"]);
  if (installed.code) throw new HubError("INVALID", `本机执行器安装或登记失败；请运行 lumio-runtime install-service。日志：${runtimeEnv.LUMIO_RUNTIME_STATE_DIR}/runtime.err.log（Linux：journalctl --user -u lumio-runtime -n 30）`);
  // The installer only prints service status; keep credentials out even on child failure.
  for (const line of installed.stdout.split("\n").filter(Boolean)) if (!line.includes(token) && !line.includes(runtimeToken)) log(line);
  if (options.server) log("Caddy 示例（按实际域名与监听地址修改）：\nlumio.example.org {\n  reverse_proxy 127.0.0.1:" + config.port + "\n}");
  log(`vault：${vault}\nHub：${url}${config.publicUrl ? `\n对外地址：${config.publicUrl}` : ""}\n日志：${platform === "linux" ? "journalctl --user -u lumio-hub -u lumio-runtime" : state}\n本机执行器：${name}\n加一台执行器：lumio runtime add <名称>（P2-8）`);
}
