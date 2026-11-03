import { type Text, untranslated } from "./language.ts";
// Shared Hub diagnostics with injected platform, command and HTTP capabilities.
export interface HubCheck { name: string; ok: boolean; problem?: string; fix?: string }
interface IO {
  text?: Text; platform: string; uid: number;
  run: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  find: (name: string) => string | null;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}
export function healthVersion(body: { version?: unknown }, msg: Text = untranslated): string {
  return typeof body.version === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(body.version) ? body.version : msg("Unknown version");
}
export async function extraServices(io: IO): Promise<HubCheck[]> {
  const msg = io.text ?? untranslated;
  const darwin = io.platform === "darwin";
  try {
    const result = await io.run(darwin ? ["launchctl", "list"] : ["systemctl", "--user", "list-units", "--all", "--type=service", "--no-legend", "--plain"]);
    if (result.code) throw new Error();
    const names = [...new Set(result.stdout.split(/\r?\n/).map((line) => darwin ? line.trim().split(/\s+/).at(-1)! : line.trim().split(/\s+/)[0]!)
      .filter((name) => darwin ? /^io\.lumio\.[a-zA-Z0-9._-]+$/.test(name) && !["io.lumio.hub", "io.lumio.runtime"].includes(name)
        : /^[a-zA-Z0-9._@-]*lumio[a-zA-Z0-9._@-]*\.service$/i.test(name) && !/^lumio-.*\.service$/.test(name)))];
    return names.length ? names.map((name) => ({ name: msg("Extra Lumio service ${0}", name), ok: false, problem: msg("Another Hub may remain"),
      fix: msg("After checking, disable: ${0} (will not be removed automatically)", darwin ? `launchctl bootout gui/${io.uid}/${name}` : `systemctl --user stop ${name}`) })) : [{ name: msg("Extra Lumio service"), ok: true }];
  } catch { return [{ name: msg("Extra Lumio service"), ok: false, problem: msg("Could not list user services"), fix: darwin ? msg("Run launchctl list to check") : msg("Run systemctl --user list-units --all to check") }]; }
}
export async function publicHubChecks(io: IO, url: string, expected: string, port: number): Promise<HubCheck[]> {
  const msg = io.text ?? untranslated;
  const checks: HubCheck[] = [];
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
    const response = await io.fetch(`${url.replace(/\/+$/, "")}/health`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { ok?: boolean; version?: unknown };
    if (!response.ok || body.ok !== true) throw new Error();
    const actual = healthVersion(body, msg);
    checks.push({ name: msg("Public URL /health"), ok: actual === expected, ...(actual !== expected ? {
      problem: msg("Public URL points to a different Hub: public Hub ${0}, local Hub ${1}", actual, expected), fix: msg("Check LUMIO_PUBLIC_URL, reverse proxy and Tailscale forwarding target") } : {}) });
  } catch { checks.push({ name: msg("Public URL /health"), ok: false, problem: msg("Could not access public URL /health"), fix: msg("Check LUMIO_PUBLIC_URL, reverse proxy, firewall and proxy (no_proxy)") }); }
  const tailscale = io.find("tailscale");
  if (tailscale) {
    try {
      const result = await io.run([tailscale, "serve", "status"]);
      if (result.code) throw new Error();
      // Only display validated local forwarding ports; raw command output may contain secrets.
      const ports = [...new Set([...result.stdout.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\b/g)].map((m) => Number(m[1])).filter((p) => p > 0 && p <= 65535))];
      const wrong = ports.some((p) => p !== port);
      checks.push({ name: "Tailscale serve status", ok: !wrong, problem: msg("Forwarded ports: ${0}; Hub port: ${1}", ports.join(", ") || msg("No local HTTP forwarding found"), port),
        ...(wrong ? { fix: msg("After checking, run tailscale serve --bg ${0}", port) } : {}) });
    } catch { checks.push({ name: "Tailscale serve status", ok: false, problem: msg("Could not read forwarding status"), fix: msg("Run tailscale serve status to check") }); }
  }
  return checks;
}
