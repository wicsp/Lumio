import { expect, test } from "bun:test";
import { doctor, supported, verifiedVersions } from "../src/doctor.ts";
import { printChecks, type DiagnosticOptions } from "../src/diagnostics.ts";
import { readFile } from "node:fs/promises";
const token = "synthetic-secret-never-print";
const runtime = { actor: "act_00000000000000000000000001", registration: { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: [], max_concurrent: 1 }, last_seen: "2026-10-29T00:00:00Z", online: true };
const routine = { routine: { id: "rtn_00000000000000000000000001", type: "routine", title: "fixture", path: "plan/routines/fixture.md" }, schedule: "* * * * *", timezone: "UTC", status: "active" };
function fixture() {
  const files: Record<string, string> = { "/synthetic/.config/lumio/config.json": JSON.stringify({ hub_url: "http://127.0.0.1:7420", token }), "/synthetic/.config/lumio/hub.env": 'LUMIO_PUBLIC_URL="http://remote.synthetic"' };
  const modes: Record<string, number> = {};
  const bodies: Record<string, unknown> = { "/health": { ok: true, version: "0.0.0-dev" }, "/v1/actors": [], "/v1/status": { watching: true, issues: [] }, "/v1/runtimes": [runtime], "/v1/routines": [routine], "/v1/proposals": [] };
  const fail = new Set<string>(), commands: string[][] = [], urls: string[] = [];
  const options: DiagnosticOptions = { home: "/synthetic", env: {}, uid: 501, find: () => null, platform: "darwin",
    read: async (p) => { if (!(p in files)) throw new Error(token); return files[p]!; },
    stat: async (p) => { if (!(p in files)) throw new Error(token); return { mode: modes[p] ?? 0o600, uid: 501, isFile: () => true, isDirectory: () => false }; },
    run: async (argv) => { commands.push(argv); return { code: fail.has("service") ? 1 : 0, stdout: "", stderr: token }; },
    fetch: (async (input, init) => {
      const u = new URL(String(input)); urls.push(u.href);
      if (u.pathname !== "/health") expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
      if (fail.has(u.pathname)) throw new Error(token);
      return Response.json(bodies[u.pathname]);
    }) as typeof fetch };
  return { options, files, modes, bodies, fail, commands, urls };
}
test("CLI doctor reports every item, HTTP warning and pending proposals without failing or exposing credentials", async () => {
  const f = fixture();
  let checks = await doctor(f.options); expect(checks.every((c) => c.ok)).toBe(true);
  expect(checks.some((c) => c.name === "对外地址警告")).toBe(true);
  expect(f.commands).toEqual([["launchctl", "list"], ["launchctl", "print", "gui/501/io.lumio.hub"], ["launchctl", "print", "gui/501/io.lumio.runtime"]]);
  const output: string[] = []; expect(printChecks(checks, false, (l) => output.push(l))).toBe(0); expect(output.at(-1)).toMatch(/项通过/);
  f.bodies["/v1/proposals"] = [{ id: "prop_00000000000000000000000001", author: runtime.actor, reason: "synthetic", status: "pending", created: runtime.last_seen,
    operation: { op: "task.dispatch", args: { task: "task_00000000000000000000000001", trigger: "cli" } } }];
  checks = await doctor(f.options); expect(checks.find((c) => c.name === "提议提醒")!.problem).toContain("1 项待批准");
  expect(JSON.stringify(checks)).not.toContain(token);
  f.options.platform = "linux"; await doctor(f.options); expect(f.commands.at(-1)).toEqual(["systemctl", "--user", "is-active", "--quiet", "lumio-runtime.service"]);
  f.options.env = { LUMIO_HUB_URL: "https://remote.synthetic" }; f.commands.length = 0;
  checks = await doctor(f.options); expect(f.commands).toHaveLength(0); expect(checks.every((c) => c.ok)).toBe(true);
});
test("CLI doctor isolates config, permissions, health, auth, vault, services, runtime, routine and public URL failures", async () => {
  for (const route of ["/health", "/v1/actors", "/v1/status", "/v1/runtimes", "/v1/routines", "/v1/proposals", "service"]) {
    const f = fixture(); f.fail.add(route); const checks = await doctor(f.options);
    expect(checks.some((c) => !c.ok)).toBe(true); expect(checks.at(-1)!.name).toBe("待批准提议");
    expect(JSON.stringify(checks)).not.toContain(token); expect(checks.filter((c) => !c.ok).every((c) => c.fix)).toBe(true);
  }
  for (const kind of ["missing", "invalid", "permissions", "url"] as const) {
    const f = fixture(), p = "/synthetic/.config/lumio/config.json";
    if (kind === "missing") delete f.files[p];
    if (kind === "invalid") f.files[p] = token;
    if (kind === "permissions") f.modes[p] = 0o644;
    if (kind === "url") f.options.env = { LUMIO_HUB_URL: `http://user:${token}@localhost` };
    const checks = await doctor(f.options); expect(checks.some((c) => !c.ok)).toBe(true); expect(JSON.stringify(checks)).not.toContain(token);
  }
  const f = fixture(); f.bodies["/health"] = { ok: true, version: "9.0.0" }; f.bodies["/v1/status"] = { watching: true, issues: ["合成笔记缺少标题", "合成目录不可写"] };
  f.bodies["/v1/runtimes"] = [{ ...runtime, online: false, registration: { ...runtime.registration, engines: [{ name: "codex", version: "0.999.0", sandbox: "os" }] } }];
  f.bodies["/v1/routines"] = [{ ...routine, problem: "缺少 workdir" }];
  let checks = await doctor(f.options);
  expect(checks.filter((c) => c.name === "Hub 问题")).toHaveLength(2);
  expect(checks.find((c) => c.name.startsWith("Hub 版本"))!.fix).toBe("运行 lumio upgrade");
  expect(checks.find((c) => c.name === "执行器 server")!.fix).toContain("lumio-runtime doctor");
  expect(checks.find((c) => c.name.includes("0.999.0"))!.ok).toBe(false);
  expect(checks.find((c) => c.name === "例行任务 fixture")!.ok).toBe(false);
  f.options.env = { LUMIO_PUBLIC_URL: "ftp://invalid" }; checks = await doctor(f.options);
  expect(checks.find((c) => c.name === "对外地址 /health")!.ok).toBe(false);
  f.bodies["/v1/runtimes"] = []; checks = await doctor(f.options); expect(checks.find((c) => c.name === "执行器")!.ok).toBe(false);
  f.bodies["/v1/runtimes"] = [{ ...runtime, registration: { ...runtime.registration, engines: [] } }]; checks = await doctor(f.options); expect(checks.find((c) => c.name === "server agent")!.ok).toBe(false);
  const output: string[] = []; expect(printChecks(checks, true, (l) => output.push(l))).toBe(1); expect(JSON.parse(output[0]!)).toEqual(checks);
});
test("CLI version ranges stay aligned with runtime adapters without cross-app imports", async () => {
  const adapters = await readFile(new URL("../../runtime/src/agents.ts", import.meta.url), "utf8");
  for (const [engine, [min, below]] of Object.entries(verifiedVersions)) {
    expect(adapters).toContain(`versions: { min: "${min}", below: "${below}" }`);
    expect(supported(engine as keyof typeof verifiedVersions, min)).toBe(true); expect(supported(engine as keyof typeof verifiedVersions, below)).toBe(false);
  }
  expect(supported("pi", "garbage")).toBe(false);
});

test("doctor diagnoses another Hub, extra services, public health mismatch and Tailscale port mismatch independently", async () => {
  const f = fixture(); f.options.find = (name) => name === "tailscale" ? "/synthetic/tailscale" : null;
  f.bodies["/health"] = { ok: true, version: "0.1.0" };
  f.options.run = async (argv) => { f.commands.push(argv); return { code: 0, stdout: argv.includes("list") ? "10 0 io.lumio.hub.p2-1\n20 0 io.lumio.runtime" : argv.includes("serve") ? "|-- / proxy http://localhost:7421" : "", stderr: token }; };
  const originalFetch = f.options.fetch!;
  f.options.fetch = (async (input, init) => String(input).startsWith("http://remote.synthetic") ? Response.json({ ok: true, version: "0.2.0" }) : originalFetch(input, init)) as typeof fetch;
  const checks = await doctor(f.options);
  expect(checks.find((c) => c.name.startsWith("Hub 版本"))!.problem).toContain("端口上是另一个 Hub");
  expect(checks.find((c) => c.name.includes("io.lumio.hub.p2-1"))!.fix).toContain("launchctl bootout gui/501/io.lumio.hub.p2-1");
  expect(checks.find((c) => c.name === "对外地址 /health")!.problem).toContain("对外地址指向的不是这个 Hub");
  expect(checks.find((c) => c.name === "Tailscale serve status")!.fix).toContain("tailscale serve --bg 7420");
  expect(f.commands.some((argv) => argv.includes("bootout") || argv.includes("--bg"))).toBe(false);
  expect(JSON.stringify(checks)).not.toContain(token);
});
test("duplicated installation helpers stay aligned across app boundaries", async () => {
  for (const [local, other] of [["download", "runtime"], ["pairing-feedback", "runtime"], ["hub-checks", "hub"]]) {
    expect(await readFile(new URL(`../src/${local}.ts`, import.meta.url), "utf8")).toBe(await readFile(new URL(`../../${other}/src/${local}.ts`, import.meta.url), "utf8"));
  }
});
