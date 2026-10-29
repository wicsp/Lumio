import { Database } from "bun:sqlite";
import { join } from "node:path";
import { HubSigningKey } from "@lumio/schema";
import { ADAPTERS, versionSupported } from "./agents.ts";
import { readConfig } from "./config.ts";
import { diagnosticIO, environment, serviceCommand, type Check, type DiagnosticOptions } from "./diagnostics.ts";
import { parseVersion } from "./engines.ts";

export async function doctor(options: DiagnosticOptions & {
  which?: (command: string, path: string) => string | null;
  outbox?: (path: string) => Promise<number>;
} = {}): Promise<Check[]> {
  const io = diagnosticIO(options), checks: Check[] = [];
  const check = async (name: string, fix: string, action: () => Promise<void>) => {
    try { await action(); checks.push({ name, ok: true }); }
    catch { checks.push({ name, ok: false, problem: "检查失败", fix }); }
  };
  const path = join(io.home, ".config/lumio-runtime/runtime.env");
  let saved: NodeJS.ProcessEnv = {}, config: ReturnType<typeof readConfig> | undefined;
  await check("runtime.env", "重新运行 lumio-runtime join 完成配对", async () => { if (!(await io.stat(path)).isFile()) throw new Error(); });
  await check("runtime.env 权限 0600", "将 ~/.config/lumio-runtime/runtime.env 权限设为 0600", async () => {
    if (((await io.stat(path)).mode & 0o777) !== 0o600) throw new Error();
  });
  await check("执行器配置", "检查 runtime.env 的 Hub 地址、令牌、名称与状态目录", async () => {
    saved = environment(await io.read(path));
    const env = { ...saved, ...Object.fromEntries(Object.entries(io.env).filter(([, v]) => v !== undefined)) };
    config = readConfig({ ...env, LUMIO_RUNTIME_STATE_DIR: env.LUMIO_RUNTIME_STATE_DIR ?? join(io.home, ".local/share/lumio-runtime") });
  });
  await check("Hub 连接与认证", "检查网络与令牌；失效时重新配对 lumio-runtime join", async () => {
    if (!config) throw new Error();
    const r = await io.fetch(`${config.url}/v1/runtime/signing-key`, { headers: { Authorization: `Bearer ${config.token}` } });
    if (!r.ok) throw new Error(); HubSigningKey.parse(await r.json());
  });
  await check("执行器后台服务", "运行 lumio-runtime install-service；查看服务日志", async () => {
    if ((await io.run(serviceCommand(io.platform, io.uid, "runtime", "status"))).code !== 0) throw new Error();
  });
  if (io.platform === "linux") await check("linger", `请管理员运行 loginctl enable-linger ${io.env.USER ?? "<用户名>"}`, async () => {
    const result = await io.run(["loginctl", "show-user", io.env.USER ?? String(io.uid), "-p", "Linger"]);
    if (result.code || result.stdout.trim() !== "Linger=yes") throw new Error();
  });
  for (const adapter of Object.values(ADAPTERS)) await check(`agent ${adapter.engine}（runtime.env PATH）`, `安装 ${adapter.command}，将路径写入 runtime.env 的 PATH；支持 [${adapter.versions.min}, ${adapter.versions.below})`, async () => {
    const executable = (options.which ?? ((command, path) => Bun.which(command, { PATH: path })))(adapter.command, saved.PATH ?? "");
    if (!executable) throw new Error();
    const result = await io.run([executable, "--version"], { ...io.env, ...saved });
    const version = parseVersion(result.stdout.trim() || result.stderr.trim());
    if (result.code || !version) throw new Error();
    checks.push({ name: `${adapter.engine} ${version}`, ok: versionSupported(adapter, version),
      ...(!versionSupported(adapter, version) ? { problem: "不在适配器验证范围内", fix: `安装支持版本 [${adapter.versions.min}, ${adapter.versions.below}) 或先验证适配器` } : {}) });
  });
  await check("状态目录权限 0700", "将执行器状态目录设为本账号所有、权限 0700", async () => {
    if (!config) throw new Error(); const s = await io.stat(config.stateDir);
    if (!s.isDirectory() || (s.mode & 0o777) !== 0o700 || s.uid !== io.uid) throw new Error();
  });
  await check("待交回结果", "检查状态数据库权限和 Hub 连接；保留数据库等待恢复", async () => {
    if (!config) throw new Error();
    const outbox = options.outbox ?? (async (path: string) => {
      const db = new Database(path, { readonly: true });
      try { return db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM outbox").get()!.count; }
      finally { db.close(); }
    });
    const count = await outbox(join(config.stateDir, "runtime.sqlite"));
    checks.push({ name: "结果队列", ok: true, problem: `${count} 项待交回`, ...(count ? { fix: "保持执行器运行；检查 Hub 连接，结果将自动交回" } : {}) });
  });
  if (config?.sudoCommand.length) {
    // sudo command includes launcher/options; validate the installed helper itself, not /usr/bin/sudo.
    const helper = config.sudoCommand.at(-1)!;
    await check("提权助手文件", "运行 sudo lumio-runtime install-sudo-helper 重新安装", async () => {
      const s = await io.stat(helper); if (!s.isFile() || s.uid !== 0 || (s.mode & 0o022)) throw new Error();
    });
    await check("sudo 授权", "运行 sudo lumio-runtime install-sudo-helper 修复 sudoers", async () => {
      const r = await io.run(["sudo", "-n", "-l"]);
      if (r.code || !r.stdout.split("\n").some((line) => line.includes("NOPASSWD:") && line.trim().endsWith(helper))) throw new Error();
    });
  }
  return checks;
}
