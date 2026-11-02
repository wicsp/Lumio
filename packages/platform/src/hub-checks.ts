// Shared Hub diagnostics with injected platform, command and HTTP capabilities.
export interface HubCheck { name: string; ok: boolean; problem?: string; fix?: string }
interface IO {
  platform: string; uid: number;
  run: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  find: (name: string) => string | null;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}
export function healthVersion(body: { version?: unknown }): string {
  return typeof body.version === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(body.version) ? body.version : "未知版本";
}
export async function extraServices(io: IO): Promise<HubCheck[]> {
  const darwin = io.platform === "darwin";
  try {
    const result = await io.run(darwin ? ["launchctl", "list"] : ["systemctl", "--user", "list-units", "--all", "--type=service", "--no-legend", "--plain"]);
    if (result.code) throw new Error();
    const names = [...new Set(result.stdout.split(/\r?\n/).map((line) => darwin ? line.trim().split(/\s+/).at(-1)! : line.trim().split(/\s+/)[0]!)
      .filter((name) => darwin ? /^io\.lumio\.[a-zA-Z0-9._-]+$/.test(name) && !["io.lumio.hub", "io.lumio.runtime"].includes(name)
        : /^[a-zA-Z0-9._@-]*lumio[a-zA-Z0-9._@-]*\.service$/i.test(name) && !/^lumio-.*\.service$/.test(name)))];
    return names.length ? names.map((name) => ({ name: `额外 Lumio 服务 ${name}`, ok: false, problem: "可能残留另一个 Hub",
      fix: `请确认后停用：${darwin ? `launchctl bootout gui/${io.uid}/${name}` : `systemctl --user stop ${name}`}（不会自动删除）` })) : [{ name: "额外 Lumio 服务", ok: true }];
  } catch { return [{ name: "额外 Lumio 服务", ok: false, problem: "无法列出用户服务", fix: darwin ? "运行 launchctl list 检查" : "运行 systemctl --user list-units --all 检查" }]; }
}
export async function publicHubChecks(io: IO, url: string, expected: string, port: number): Promise<HubCheck[]> {
  const checks: HubCheck[] = [];
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
    const response = await io.fetch(`${url.replace(/\/+$/, "")}/health`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { ok?: boolean; version?: unknown };
    if (!response.ok || body.ok !== true) throw new Error();
    const actual = healthVersion(body);
    checks.push({ name: "对外地址 /health", ok: actual === expected, ...(actual !== expected ? {
      problem: `对外地址指向的不是这个 Hub：对外 Hub 是 ${actual}，本机 Hub 是 ${expected}`, fix: "检查 LUMIO_PUBLIC_URL、反向代理和 Tailscale 转发目标" } : {}) });
  } catch { checks.push({ name: "对外地址 /health", ok: false, problem: "无法访问对外地址的 /health", fix: "检查 LUMIO_PUBLIC_URL、反向代理、防火墙和代理（no_proxy）" }); }
  const tailscale = io.find("tailscale");
  if (tailscale) {
    try {
      const result = await io.run([tailscale, "serve", "status"]);
      if (result.code) throw new Error();
      // Only display validated local forwarding ports; raw command output may contain secrets.
      const ports = [...new Set([...result.stdout.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\b/g)].map((m) => Number(m[1])).filter((p) => p > 0 && p <= 65535))];
      const wrong = ports.some((p) => p !== port);
      checks.push({ name: "Tailscale serve status", ok: !wrong, problem: `转发目标端口：${ports.join(", ") || "未发现本机 HTTP 转发"}；Hub 端口：${port}`,
        ...(wrong ? { fix: `请确认后运行 tailscale serve --bg ${port}` } : {}) });
    } catch { checks.push({ name: "Tailscale serve status", ok: false, problem: "无法读取转发状态", fix: "运行 tailscale serve status 检查" }); }
  }
  return checks;
}
