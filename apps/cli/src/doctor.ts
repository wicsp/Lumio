import { extraServices, healthVersion, publicHubChecks } from "./hub-checks.ts";
import { join } from "node:path";
import { createClient } from "@lumio/api-client";
import { CliConfig } from "@lumio/schema";
import { diagnosticIO, environment, httpURL, localAddress, serviceCommand, type Check, type DiagnosticOptions } from "./diagnostics.ts";
import { version } from "./version.ts";

// Mirrors the runtime adapters without an app-to-app import. A parity test guards changes.
export const verifiedVersions = { codex: ["0.160.0", "0.200.0"], "claude-code": ["2.0.0", "3.0.0"], pi: ["1.4.0", "2.0.0"] } as const;
export function supported(engine: keyof typeof verifiedVersions, value: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!parts) return false;
  const compare = (other: string) => {
    const b = other.split(".").map(Number);
    for (let i = 0; i < 3; i++) { const d = Number(parts[i + 1]) - b[i]!; if (d) return Math.sign(d); }
    return 0;
  };
  return compare(verifiedVersions[engine][0]) >= 0 && compare(verifiedVersions[engine][1]) < 0;
}
export async function doctor(options: DiagnosticOptions = {}): Promise<Check[]> {
  const io = diagnosticIO(options), checks: Check[] = [];
  const check = async (name: string, fix: string, action: () => Promise<void>) => {
    try { await action(); checks.push({ name, ok: true }); }
    catch { checks.push({ name, ok: false, problem: "检查失败", fix }); }
  };
  const configPath = join(io.home, ".config/lumio/config.json");
  let file: Partial<CliConfig> = {};
  await check("配置文件", "运行 lumio-hub setup；远程 CLI 用 lumio login", async () => {
    if (!(await io.stat(configPath)).isFile()) throw new Error();
  });
  await check("配置权限 0600", "将 ~/.config/lumio/config.json 权限设为 0600", async () => {
    if (((await io.stat(configPath)).mode & 0o777) !== 0o600) throw new Error();
  });
  await check("配置格式", "重新运行 lumio-hub setup 或 lumio login", async () => {
    file = CliConfig.partial({ token: true }).parse(JSON.parse(await io.read(configPath)));
  });
  const url = io.env.LUMIO_HUB_URL ?? file.hub_url, token = io.env.LUMIO_TOKEN ?? file.token;
  let base: string | undefined;
  await check("Hub 地址与令牌配置", "运行 lumio-hub setup 或 lumio login", async () => {
    if (!url || !token) throw new Error(); base = httpURL(url).href.replace(/\/+$/, "");
  });
  let hubVersion = version;
  const client = createClient({ url: base ?? "http://invalid", token, fetch: io.fetch });
  await check("Hub /health", "检查 Hub 服务、地址和网络；运行 lumio-hub setup 修复本机安装", async () => {
    if (!base) throw new Error();
    const r = await io.fetch(`${base}/health`); const body = await r.json() as { ok?: boolean; version?: string };
    if (!r.ok || body.ok !== true || typeof body.version !== "string") throw new Error();
    hubVersion = healthVersion(body);
    checks.push({ name: `Hub 版本 ${hubVersion} / CLI ${version}`, ok: hubVersion === version,
      ...(hubVersion !== version ? { problem: localAddress(new URL(base)) ? "端口上是另一个 Hub，版本不一致" : "版本不一致", fix: "运行 lumio upgrade" } : {}) });
  });
  await check("Hub 令牌", "运行 lumio login 重新登录或 lumio-hub setup", async () => { if (!base) throw new Error(); await client.actors(); });
  await check("vault 状态", "检查 Hub 对 vault 的读写权限并查看 Hub 日志", async () => {
    if (!base) throw new Error();
    const r = await io.fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${token}` } });
    const status = await r.json() as { watching?: boolean; issues?: unknown };
    if (!r.ok || status.watching !== true || !Array.isArray(status.issues) || !status.issues.every((s) => typeof s === "string")) throw new Error();
    for (const issue of status.issues as string[]) checks.push({ name: "Hub 问题", ok: false, problem: issue, fix: "按提示修复笔记或 vault 权限，查看 Hub 日志" });
  });
  if (base && localAddress(new URL(base))) {
    checks.push(...await extraServices(io));
    for (const service of ["hub", "runtime"] as const) await check(`本机 ${service} 后台服务`, `运行 lumio-hub setup（${service} 服务未启动）`, async () => {
      if ((await io.run(serviceCommand(io.platform, io.uid, service, "status"))).code !== 0) throw new Error();
    });
  }
  let publicUrl = io.env.LUMIO_PUBLIC_URL;
  if (!publicUrl && base && localAddress(new URL(base))) {
    try { publicUrl = environment(await io.read(join(io.home, ".config/lumio/hub.env"))).LUMIO_PUBLIC_URL; } catch { /* no local Hub configuration */ }
  }
  if (publicUrl) {
    try {
      const u = httpURL(publicUrl);
      if (u.protocol === "http:" && !localAddress(u)) checks.push({ name: "对外地址警告", ok: true, problem: "非本机地址使用 HTTP", fix: "建议配置 HTTPS 反向代理或使用可信私网" });
      checks.push(...await publicHubChecks(io, publicUrl, hubVersion, base ? Number(new URL(base).port || (new URL(base).protocol === "https:" ? 443 : 80)) : 7420));
    } catch { checks.push({ name: "对外地址 /health", ok: false, problem: "地址不合法", fix: "检查 LUMIO_PUBLIC_URL" }); }
  }
  await check("执行器列表", "检查 Hub 认证；用 lumio runtime add 登记执行器", async () => {
    if (!base) throw new Error(); const runtimes = await client.runtimes();
    if (!runtimes.length) checks.push({ name: "执行器", ok: false, problem: "尚无已登记的执行器", fix: "运行 lumio-hub setup 或 lumio runtime add <名称>" });
    for (const r of runtimes) {
      checks.push({ name: `执行器 ${r.registration.name}`, ok: r.online, problem: `最近一次：${r.last_seen}${r.online ? "" : "（离线）"}`,
        ...(!r.online ? { fix: "在服务器上运行 lumio-runtime doctor" } : {}) });
      if (!r.registration.engines.length) checks.push({ name: `${r.registration.name} agent`, ok: false, problem: "未检测到 agent", fix: "安装 agent 并更新 runtime.env 的 PATH，重启执行器" });
      for (const e of r.registration.engines) checks.push({ name: `${r.registration.name} ${e.name} ${e.version}`, ok: supported(e.name, e.version),
        ...(!supported(e.name, e.version) ? { problem: "不在适配器验证范围内", fix: `安装 ${e.name} 版本 [${verifiedVersions[e.name].join(", ")})，或先验证适配器` } : {}) });
    }
  });
  await check("例行任务", "运行 lumio routine list 查看并修复计划", async () => {
    if (!base) throw new Error();
    for (const r of await client.routines()) if (r.problem) checks.push({ name: `例行任务 ${r.routine.title}`, ok: false, problem: r.problem, fix: "修复例行任务配置后重新检查" });
  });
  await check("待批准提议", "运行 lumio proposals", async () => {
    if (!base) throw new Error(); const pending = await client.proposals();
    if (pending.length) checks.push({ name: "提议提醒", ok: true, problem: `${pending.length} 项待批准`, fix: "运行 lumio proposals" });
  });
  return checks;
}
