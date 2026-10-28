import { createHash } from "node:crypto";
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { createInterface } from "node:readline/promises";
import { HubSigningKey, RuntimeInfo, signingKeyFingerprint } from "@lumio/schema";
import { readConfig, RuntimeError } from "./config.ts";
import { environmentText, optionalFile } from "./pairing.ts";
import { parseEnvironment, privateFile, runCommand, type RunCommand } from "./service.ts";

export interface SudoPaths { binary: string; config: string; state: string; sudoers: string }
const paths: SudoPaths = { binary: "/usr/local/libexec/lumio-sudo-helper", config: "/etc/lumio/sudo.json", state: "/var/lib/lumio-sudo", sudoers: "/etc/sudoers.d/lumio" };
interface Account { name: string; uid: number; gid: number; home: string }
async function confirmFingerprint(): Promise<boolean> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question("确认与 Hub 上 lumio-hub signing-key 显示的指纹一致？输入 yes：")).trim() === "yes"; }
  finally { input.close(); }
}
/** Runs as the runtime user, including when requested by the root installer. */
export async function configureSudoEnvironment(home: string, command?: string) {
  const file = join(home, ".config/lumio-runtime/runtime.env");
  const env = parseEnvironment(await readFile(file, "utf8"));
  if (command) env.LUMIO_RUNTIME_SUDO_COMMAND = command;
  else delete env.LUMIO_RUNTIME_SUDO_COMMAND;
  await privateFile(file, environmentText(env));
}
export async function installSudoHelper(args: string[], options: {
  platform?: string; uid?: number; env?: NodeJS.ProcessEnv; binary?: string; paths?: SudoPaths;
  run?: RunCommand; fetch?: typeof globalThis.fetch; log?: (line: string) => void;
  interactive?: boolean; confirm?: () => Promise<boolean>;
  /** Synthetic filesystem ownership only; never exposed as a command-line option. */
  owner?: number; group?: number;
} = {}) {
  if ((options.platform ?? process.platform) !== "linux") throw new RuntimeError("提权助手仅支持 Linux");
  if ((options.uid ?? process.getuid?.()) !== 0) throw new RuntimeError("请用 sudo lumio-runtime install-sudo-helper 以 root 运行");
  const env = options.env ?? process.env, user = env.SUDO_USER;
  if (!user || user === "root" || !/^[a-z_][a-z0-9_-]*\$?$/.test(user)) throw new RuntimeError("需要有效的 SUDO_USER，请从执行器账号通过 sudo 运行");
  if (args.length && !(args.length === 1 && args[0] === "--uninstall")) throw new RuntimeError("用法：lumio-runtime install-sudo-helper [--uninstall]");
  const uninstall = args[0] === "--uninstall", run = options.run ?? runCommand, log = options.log ?? console.log;
  const entry = await run(["/usr/bin/getent", "passwd", user]);
  const fields = entry.stdout.trim().split(":");
  const account: Account = { name: user, uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] ?? "" };
  if (entry.code || fields.length !== 7 || fields[0] !== user || !Number.isSafeInteger(account.uid) || account.uid <= 0 || !Number.isSafeInteger(account.gid) || account.gid < 0 || !isAbsolute(account.home)) throw new RuntimeError("无法找到执行器账号的主目录与 UID");
  const target = options.paths ?? paths, owner = options.owner ?? 0, group = options.group ?? 0;
  const envFile = join(account.home, ".config/lumio-runtime/runtime.env");
  const runtimeEnv = parseEnvironment(await readFile(envFile, "utf8"));
  const source = options.binary ?? process.execPath;
  if (!uninstall && source === process.execPath && !Bun.main.startsWith("/$bunfs/")) throw new RuntimeError("请用 install.sh 安装的程序运行 install-sudo-helper");
  // Root never writes into a user-controlled directory. The helper updates runtime.env after dropping privileges.
  async function configure(command?: string) {
    const argv = ["/usr/sbin/runuser", "-u", user!, "--", "/usr/bin/env", "-i", `HOME=${account.home}`, `USER=${user}`, "PATH=/usr/bin:/bin", `XDG_RUNTIME_DIR=/run/user/${account.uid}`, (uninstall ? source : target.binary), "--configure-sudo-helper", ...(command ? [command] : [])];
    if ((await run(argv)).code) throw new RuntimeError("无法更新 runtime.env，请检查执行器账号的配置权限");
  }
  async function restart() {
    try {
      if ((await run(["/usr/sbin/runuser", "-u", user!, "--", "/usr/bin/env", `XDG_RUNTIME_DIR=/run/user/${account.uid}`, "systemctl", "--user", "restart", "lumio-runtime.service"])).code === 0) return;
    } catch { /* tell the human how to recover */ }
    log("请以执行器账号运行 systemctl --user restart lumio-runtime.service");
  }
  async function safeDirectory(path: string, mode = 0o755) {
    try {
      const st = await lstat(path);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== owner || (st.mode & 0o022)) throw new RuntimeError("提权助手安装目录权限不安全");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      await mkdir(path, { mode }); await chown(path, owner, group); await chmod(path, mode);
    }
  }
  async function safeParents(path: string) {
    const dirs: string[] = [];
    for (let dir = dirname(path); dir !== parse(dir).root; dir = dirname(dir)) { dirs.unshift(dir); if (options.owner !== undefined) break; }
    for (const dir of dirs) await safeDirectory(dir);
  }
  if (uninstall) {
    // Validate root-managed parent directories before removing anything; retain replay prevention data.
    for (const file of [target.binary, target.config, target.sudoers]) await safeParents(file);
    await configure();
    for (const file of [target.sudoers, target.config, target.binary]) await rm(file, { force: true });
    await restart(); log("提权助手已卸载；已用凭据记录保留"); return;
  }
  if (!(options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) throw new RuntimeError("需要交互终端核对 Hub 公钥指纹；未安装提权助手");
  const config = readConfig({ ...runtimeEnv, LUMIO_RUNTIME_STATE_DIR: runtimeEnv.LUMIO_RUNTIME_STATE_DIR ?? join(account.home, ".local/share/lumio-runtime") }), fetcher = options.fetch ?? globalThis.fetch;
  async function request<T>(path: string, schema: { parse(value: unknown): T }, body?: unknown): Promise<T> {
    try {
      const response = await fetcher(`${config.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: {
        Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      return schema.parse(await response.json());
    } catch { throw new RuntimeError("无法向 Hub 验证执行器身份与签名公钥；未安装提权助手"); }
  }
  const key = await request("/v1/runtime/signing-key", HubSigningKey);
  const fingerprint = signingKeyFingerprint(createHash("sha256").update(Buffer.from(key.public_key, "base64url")).digest("hex"));
  if (fingerprint !== key.fingerprint) throw new RuntimeError("Hub 公钥指纹不匹配；未安装提权助手");
  log(`Hub 公钥指纹：${fingerprint}`);
  if (!await (options.confirm ?? confirmFingerprint)()) throw new RuntimeError("指纹未确认；未安装提权助手");
  const receipt = await optionalFile(join(config.stateDir, "registered.json"));
  const registration = receipt ? RuntimeInfo.parse(JSON.parse(receipt)).registration : config.registration;
  if (registration.name !== config.registration.name) throw new RuntimeError("执行器登记名称不匹配");
  const info = await request("/v1/runtime/register", RuntimeInfo, registration);
  if (info.registration.name !== config.registration.name) throw new RuntimeError("执行器登记名称不匹配");
  // Validate sudoers before installing any files. All paths are fixed in production.
  const stage = await mkdtemp(join(tmpdir(), "lumio-sudo-install-"));
  const sudoers = `${user} ALL=(root) NOPASSWD: ${target.binary} --sudo-helper\n`;
  try {
    const staged = join(stage, "sudoers"); await writeFile(staged, sudoers, { mode: 0o440 });
    if ((await run(["/usr/sbin/visudo", "-cf", staged])).code) throw new RuntimeError("visudo 校验失败；未安装提权助手");
    for (const file of [target.binary, target.config, target.sudoers, join(target.state, "used")]) await safeParents(file);
    await chmod(target.state, 0o700);
    async function installFile(path: string, mode: number, content?: string) {
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        if (content === undefined) await copyFile(source, temp);
        else await writeFile(temp, content, { flag: "wx", mode });
        await chown(temp, owner, group); await chmod(temp, mode); await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    }
    await installFile(target.binary, 0o755);
    await installFile(target.config, 0o644, JSON.stringify({ public_key: key.public_key, runtime: info.actor }) + "\n");
    // Install the validated sudoers content atomically on its destination filesystem.
    const temp = `${target.sudoers}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temp, sudoers, { flag: "wx", mode: 0o440 }); await chown(temp, owner, group); await chmod(temp, 0o440);
      await rename(temp, target.sudoers);
    } finally { await rm(temp, { force: true }); }
    await configure(`/usr/bin/sudo -n ${target.binary} --sudo-helper`);
    await restart(); log("提权助手已安装");
  } finally { await rm(stage, { recursive: true, force: true }); }
}
