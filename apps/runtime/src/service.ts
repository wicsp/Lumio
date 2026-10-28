import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RuntimeInfo } from "@lumio/schema";
import { RuntimeError } from "./config.ts";

export interface CommandResult { code: number; stdout: string; stderr: string }
export type RunCommand = (argv: string[]) => Promise<CommandResult>;
export const runCommand: RunCommand = async (argv) => {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};
async function atomicFile(path: string, content: string, mode: number, privateDirectory = false) {
  await mkdir(dirname(path), { recursive: true, mode: privateDirectory ? 0o700 : 0o755 });
  if (privateDirectory) await chmod(dirname(path), 0o700);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temp, content, { mode, flag: "wx" }); await chmod(temp, mode); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export const privateFile = (path: string, content: string) => atomicFile(path, content, 0o600, true);
/** Our generated format is also accepted by systemd EnvironmentFile (no shell expansion). */
export function parseEnvironment(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new RuntimeError("runtime.env 格式不合法");
    let value = match[2]!;
    if (value.startsWith('"')) {
      if (!value.endsWith('"')) throw new RuntimeError("runtime.env 格式不合法");
      value = value.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    env[match[1]!] = value;
  }
  return env;
}
export function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function unitString(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`; }
export function runtimePlist(binary: string, env: Record<string, string>, state: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.lumio.runtime</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(state, "runtime.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, "runtime.err.log"))}</string>
</dict></plist>\n`;
}
export function runtimeUnit(binary: string, envFile: string): string {
  return `[Unit]\nDescription=Lumio runtime\nAfter=network.target\n\n[Service]\nExecStart=${unitString(binary)}\nEnvironmentFile=${unitString(envFile)}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}
export interface ServiceOptions {
  home?: string; platform?: string; binary?: string; uid?: number; user?: string;
  run?: RunCommand; log?: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>;
}
export async function installService(options: ServiceOptions = {}): Promise<void> {
  const home = resolve(options.home ?? process.env.HOME ?? homedir());
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand, log = options.log ?? console.log;
  const binary = options.binary ?? process.execPath;
  if (binary === process.execPath && !Bun.main.startsWith("/$bunfs/")) throw new RuntimeError("请用 install.sh 安装的程序运行 install-service；从源码运行不会安装后台服务");
  if (!isAbsolute(binary) || /[\r\n]/.test(binary)) throw new RuntimeError("执行器程序路径必须是绝对路径");
  const envFile = join(home, ".config/lumio-runtime/runtime.env");
  const env = parseEnvironment(await readFile(envFile, "utf8"));
  const state = env.LUMIO_RUNTIME_STATE_DIR ?? join(home, ".local/share/lumio-runtime");
  if (!isAbsolute(state)) throw new RuntimeError("执行器状态目录必须是绝对路径");
  await mkdir(state, { recursive: true, mode: 0o700 }); await chmod(state, 0o700);
  const receipt = join(state, "registered.json");
  await rm(receipt, { force: true });
  if (platform === "darwin") {
    const path = join(home, "Library/LaunchAgents/io.lumio.runtime.plist");
    await atomicFile(path, runtimePlist(binary, env, state), 0o600);
    if ((await run(["plutil", "-lint", path])).code) throw new RuntimeError("执行器服务配置校验失败");
    const domain = `gui/${options.uid ?? process.getuid!()}`;
    await run(["launchctl", "bootout", domain, path]);
    if ((await run(["launchctl", "bootstrap", domain, path])).code) throw new RuntimeError(`执行器服务无法启动，请查看 ${state}/runtime.err.log`);
  } else if (platform === "linux") {
    const path = join(home, ".config/systemd/user/lumio-runtime.service");
    await atomicFile(path, runtimeUnit(binary, envFile), 0o644);
    let available = false;
    try { available = (await run(["systemctl", "--user", "show-environment"])).code === 0; } catch { /* manual fallback */ }
    if (!available) {
      log(`没有 systemd 用户服务。手动运行：nohup '${binary.replaceAll("'", "'\\''")}' > '${state.replaceAll("'", "'\\''")}/runtime.log' 2>&1 &（程序自动读取 ${envFile}）；也可放入 crontab @reboot。`);
      return;
    }
    const active = (await run(["systemctl", "--user", "is-active", "--quiet", "lumio-runtime.service"])).code === 0;
    for (const argv of [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "lumio-runtime.service"], ...(active ? [["systemctl", "--user", "restart", "lumio-runtime.service"]] : [])]) {
      if ((await run(argv)).code) throw new RuntimeError("执行器服务无法启动；请运行 journalctl --user -u lumio-runtime -n 30");
    }
    let linger = "";
    try { linger = (await run(["loginctl", "show-user", options.user ?? process.env.USER ?? "", "-p", "Linger"])).stdout; } catch { /* report below */ }
    if (!linger.includes("Linger=yes")) log(`退出登录后执行器会停止；请管理员运行 loginctl enable-linger ${options.user ?? process.env.USER ?? "<用户名>"}`);
  } else throw new RuntimeError("只支持 macOS 与 Linux");
  const now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep;
  const until = now() + 30_000;
  while (now() < until) {
    try {
      const info = RuntimeInfo.parse(JSON.parse(await readFile(receipt, "utf8")));
      if (info.registration.name === env.LUMIO_RUNTIME_NAME) {
        log(`已连上 Hub；检测到：${info.registration.engines.map((engine) => `${engine.name} ${engine.version}`).join("、") || "未找到 agent（请检查 PATH）"}`);
        return;
      }
    } catch { /* wait for a fresh successful registration */ }
    await sleep(500);
  }
  throw new RuntimeError(platform === "linux" ? "执行器登记超时；请运行 journalctl --user -u lumio-runtime -n 30" : `执行器登记超时；请查看 ${state}/runtime.err.log`);
}

export async function runtimeEnvironment(home = process.env.HOME ?? homedir(), env = process.env): Promise<NodeJS.ProcessEnv> {
  try { return { ...parseEnvironment(await readFile(join(home, ".config/lumio-runtime/runtime.env"), "utf8")), ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) }; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return env; throw cause; }
}
