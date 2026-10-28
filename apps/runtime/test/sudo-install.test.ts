import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HubSigningKey, RuntimeInfo, signingKeyFingerprint } from "@lumio/schema";
import { configureSudoEnvironment, installSudoHelper, type SudoPaths } from "../src/sudo-install.ts";
import { environmentText } from "../src/pairing.ts";
import { parseEnvironment, type RunCommand } from "../src/service.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lumio-sudo-install-test-")); roots.push(root);
  const home = join(root, "user"), file = join(home, ".config/lumio-runtime/runtime.env"), binary = join(root, "lumio-runtime");
  const paths: SudoPaths = { binary: join(root, "libexec/helper"), config: join(root, "etc/sudo.json"), state: join(root, "state"), sudoers: join(root, "sudoers/lumio") };
  await mkdir(dirname(file), { recursive: true }); await writeFile(binary, "synthetic-binary");
  await writeFile(file, environmentText({ LUMIO_HUB_URL: "https://synthetic.example", LUMIO_TOKEN: "synthetic-token", LUMIO_RUNTIME_NAME: "synthetic", LUMIO_RUNTIME_TAGS: "lab", LUMIO_RUNTIME_STATE_DIR: join(root, "runtime-state") }));
  const public_key = Buffer.alloc(32, 3).toString("base64url");
  const key = HubSigningKey.parse({ public_key, fingerprint: signingKeyFingerprint(createHash("sha256").update(Buffer.from(public_key, "base64url")).digest("hex")) });
  const info = RuntimeInfo.parse({ actor: "act_00000000000000000000000001", registration: { protocol_version: 2, name: "synthetic", engines: [], tags: ["lab"], max_concurrent: 1 }, last_seen: new Date().toISOString(), online: true });
  const commands: string[][] = [], logs: string[] = [];
  let visudo = 0, restart = 0;
  const run: RunCommand = async (argv) => {
    commands.push(argv);
    if (argv[0] === "/usr/bin/getent") return { code: 0, stdout: `synthetic:x:1234:1234::${home}:/bin/bash`, stderr: "" };
    if (argv[0] === "/usr/sbin/visudo") { expect(await readFile(argv[2]!, "utf8")).toBe(`synthetic ALL=(root) NOPASSWD: ${paths.binary} --sudo-helper\n`); return { code: visudo, stdout: "", stderr: "" }; }
    if (argv.includes("--configure-sudo-helper")) await configureSudoEnvironment(home, argv[argv.indexOf("--configure-sudo-helper") + 1]);
    return { code: argv.includes("restart") ? restart : 0, stdout: "", stderr: "" };
  };
  const fetcher = (async (url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-token"); expect(init.redirect).toBe("error");
    if (url.endsWith("/signing-key")) return Response.json(key);
    expect(JSON.parse(String(init.body))).toEqual(info.registration); return Response.json(info);
  }) as unknown as typeof fetch;
  const options = { platform: "linux", uid: 0, env: { SUDO_USER: "synthetic" }, binary, paths, owner: process.getuid!(), group: process.getgid!(), interactive: true, confirm: async () => true, run, fetch: fetcher, log: (line: string) => logs.push(line) };
  return { root, home, file, binary, paths, options, commands, logs, key, info, failVisudo: () => { visudo = 1; }, failRestart: () => { restart = 1; } };
}
test("sudo installer refuses non-Linux, non-root, absent SUDO_USER, non-interactive, unconfirmed fingerprint and invalid sudoers without installing", async () => {
  const f = await fixture();
  for (const override of [{ platform: "darwin" }, { uid: 123 }, { env: {} }, { interactive: false }, { confirm: async () => false }]) {
    await expect(installSudoHelper([], { ...f.options, ...override })).rejects.toThrow();
    for (const path of [f.paths.binary, f.paths.config, f.paths.sudoers, f.paths.state]) expect(await Bun.file(path).exists()).toBe(false);
  }
  f.failVisudo(); await expect(installSudoHelper([], f.options)).rejects.toThrow("visudo 校验失败");
  for (const path of [f.paths.binary, f.paths.config, f.paths.sudoers, f.paths.state]) expect(await Bun.file(path).exists()).toBe(false);
  expect(parseEnvironment(await readFile(f.file, "utf8")).LUMIO_RUNTIME_SUDO_COMMAND).toBeUndefined();
});
test("confirmed installation writes correct root-managed files/modes, configures as user, restarts and can upgrade/uninstall while preserving used records", async () => {
  const f = await fixture(); f.failRestart();
  await installSudoHelper([], f.options);
  expect(await readFile(f.paths.binary, "utf8")).toBe("synthetic-binary");
  expect(JSON.parse(await readFile(f.paths.config, "utf8"))).toEqual({ public_key: f.key.public_key, runtime: f.info.actor });
  for (const [path, mode] of [[f.paths.binary, 0o755], [f.paths.config, 0o644], [f.paths.sudoers, 0o440], [f.paths.state, 0o700]] as const) {
    expect((await stat(path)).mode & 0o777).toBe(mode); expect((await stat(path)).uid).toBe(process.getuid!());
  }
  const values = parseEnvironment(await readFile(f.file, "utf8")); expect(values.LUMIO_RUNTIME_SUDO_COMMAND).toBe(`/usr/bin/sudo -n ${f.paths.binary} --sudo-helper`); expect(values.LUMIO_RUNTIME_TAGS).toBe("lab"); expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect(f.logs.join("\n")).toContain(f.key.fingerprint); expect(f.logs.join("\n")).toContain("请以执行器账号"); expect(f.logs.join("\n")).not.toContain("synthetic-token");
  expect(f.commands).toContainEqual(["/usr/sbin/runuser", "-u", "synthetic", "--", "/usr/bin/env", "XDG_RUNTIME_DIR=/run/user/1234", "systemctl", "--user", "restart", "lumio-runtime.service"]);
  await writeFile(join(f.paths.state, "used"), "used-proposal\n", { mode: 0o600 });
  await writeFile(f.binary, "upgraded"); await installSudoHelper([], f.options); expect(await readFile(f.paths.binary, "utf8")).toBe("upgraded");
  await installSudoHelper(["--uninstall"], { ...f.options, interactive: false });
  for (const path of [f.paths.binary, f.paths.config, f.paths.sudoers]) expect(await Bun.file(path).exists()).toBe(false);
  expect(await readFile(join(f.paths.state, "used"), "utf8")).toBe("used-proposal\n"); expect(parseEnvironment(await readFile(f.file, "utf8")).LUMIO_RUNTIME_SUDO_COMMAND).toBeUndefined();
});
test("mismatching computed fingerprint is rejected before confirmation or filesystem changes", async () => {
  const f = await fixture();
  await expect(installSudoHelper([], { ...f.options, fetch: (async () => Response.json({ ...f.key, fingerprint: "0000-0000-0000-0000" })) as unknown as typeof fetch, confirm: async () => { throw new Error("must not confirm"); } })).rejects.toThrow("指纹不匹配");
  expect(await Bun.file(f.paths.binary).exists()).toBe(false);
});
