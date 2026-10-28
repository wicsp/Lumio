import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConfig } from "@lumio/schema";
import { networkWarning, readConfig } from "../src/config.ts";
import { environmentText, parseEnvironment, runtimeName, setup, type SetupOptions } from "../src/setup.ts";
import { HubStore } from "../src/store.ts";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture(platform = "darwin") {
  const home = await mkdtemp(join(tmpdir(), "lumio-setup-")); homes.push(home);
  const commands: string[][] = [], logs: string[] = [];
  const options: SetupOptions = {
    home, platform, host: "My Mac.local", binary: `${home}/bin/lumio-hub`, yes: true,
    env: { HOME: home, USER: "synthetic", PATH: `${home}/agents:/usr/bin:/bin` }, uid: 123,
    find: (name) => name === "git" ? "/opt/git/bin/git" : null,
    run: async (argv) => { commands.push(argv); return { code: 0, stdout: argv[0]?.endsWith("lumio-runtime") ? "已连上 Hub；检测到：codex 0.163.0" : "Linger=yes", stderr: "" }; },
    fetch: (async () => Response.json({ ok: true })), log: (line) => logs.push(line),
  };
  return { home, options, commands, logs, config: async () => CliConfig.parse(JSON.parse(await readFile(join(home, ".config/lumio/config.json"), "utf8"))) };
}
test("first setup creates default vault, private config, launchd services and local runtime; rerun preserves identity and rotates credentials", async () => {
  const f = await fixture(); await setup(f.options);
  const config = await f.config(); expect(config.vault).toBe(join(f.home, ".config/lumio/vault"));
  expect(await readFile(join(config.vault!, "README.md"), "utf8")).toContain("Lumio vault");
  for (const path of [".config/lumio/config.json", ".config/lumio/hub.env", ".config/lumio-runtime/runtime.env"]) expect((await stat(join(f.home, path))).mode & 0o777).toBe(0o600);
  for (const path of [".config/lumio", ".local/share/lumio", ".config/lumio-runtime"]) expect((await stat(join(f.home, path))).mode & 0o777).toBe(0o700);
  const plist = await readFile(join(f.home, "Library/LaunchAgents/io.lumio.hub.plist"), "utf8");
  for (const value of [f.home + "/bin/lumio-hub", config.vault!, "127.0.0.1:7420", "/opt/git/bin", "hub.err.log"]) expect(plist).toContain(value);
  expect(plist).not.toContain("~"); expect(plist).not.toContain("LUMIO_PUBLIC_URL");
  expect(f.commands).toContainEqual(["plutil", "-lint", join(f.home, "Library/LaunchAgents/io.lumio.hub.plist")]);
  expect(f.commands).toContainEqual([f.home + "/bin/lumio-runtime", "install-service"]);
  const runtimeFile = join(f.home, ".config/lumio-runtime/runtime.env");
  const oldRuntime = parseEnvironment(await readFile(runtimeFile, "utf8"));
  expect(oldRuntime.PATH).toBe(f.options.env!.PATH!); expect(oldRuntime.LUMIO_RUNTIME_NAME).toBe("my-mac.local");
  await writeFile(runtimeFile, environmentText({ ...oldRuntime, LUMIO_RUNTIME_TAGS: "gpu:4", LUMIO_RUNTIME_ALLOWED_COMMANDS: "/usr/bin/true" }));
  const store = await HubStore.open(join(f.home, ".local/share/lumio")); const actors = store.actors(); const manualRuntimeToken = store.createToken("manual-runtime-old", "my-mac.local"); store.close();
  await setup(f.options);
  const updated = await f.config(); expect(updated.token).not.toBe(config.token);
  const reopened = await HubStore.open(join(f.home, ".local/share/lumio"));
  try {
    expect(reopened.actors()).toEqual(actors);
    expect(reopened.authenticate(`Bearer ${config.token}`)).toBeNull();
    expect(reopened.authenticate(`Bearer ${updated.token}`)?.actor.role).toBe("human");
    expect(reopened.authenticate(`Bearer ${oldRuntime.LUMIO_TOKEN}`)).toBeNull();
    expect(reopened.authenticate(`Bearer ${manualRuntimeToken}`)).toBeNull();
  } finally { reopened.close(); }
  const runtime = parseEnvironment(await readFile(runtimeFile, "utf8")); expect(runtime.LUMIO_RUNTIME_TAGS).toBe("gpu:4");
  expect(f.logs.join("\n")).toContain("codex 0.163.0");
  for (const secret of [config.token, updated.token, runtime.LUMIO_TOKEN!]) expect(f.logs.join("\n")).not.toContain(secret);
});
test("explicit vault must exist; existing configuration supplies the vault on subsequent runs", async () => {
  const f = await fixture(); await expect(setup({ ...f.options, vault: join(f.home, "missing") })).rejects.toThrow("vault");
  const vault = join(f.home, "existing vault & notes"); await mkdir(vault);
  await setup({ ...f.options, vault }); await setup(f.options); expect((await f.config()).vault).toBe(vault);
  expect(await readFile(join(f.home, "Library/LaunchAgents/io.lumio.hub.plist"), "utf8")).toContain("&amp;");
});
test("server setup writes Linux units and HTTPS proxy guidance; HTTP warns, no systemd falls back to manual commands", async () => {
  const f = await fixture("linux");
  await setup({ ...f.options, server: true, yes: false, ask: async (question, fallback) => question.startsWith("对外") ? "http://hub.example.org" : fallback });
  expect(await readFile(join(f.home, ".config/systemd/user/lumio-hub.service"), "utf8")).toContain(`ExecStart="${f.home}/bin/lumio-hub"`);
  const env = parseEnvironment(await readFile(join(f.home, ".config/lumio/hub.env"), "utf8"));
  expect(env.LUMIO_HUB_LISTEN).toBe("0.0.0.0:7420"); expect(env.LUMIO_PUBLIC_URL).toBe("http://hub.example.org");
  expect(f.logs.join("\n")).toContain("明文"); expect(f.logs.join("\n")).toContain("reverse_proxy 127.0.0.1:7420");
  f.logs.length = 0;
  await setup({ ...f.options, run: async (argv) => ({ code: argv.includes("show-environment") ? 1 : 0, stdout: "", stderr: "" }) });
  expect(f.logs.join("\n")).toContain("nohup");
  f.logs.length = 0;
  await setup({ ...f.options, run: async (argv) => ({ code: argv.includes("is-active") ? 1 : 0, stdout: "Linger=no", stderr: "" }) });
  expect(f.logs.join("\n")).toContain("loginctl enable-linger synthetic");
});
test("startup timeouts diagnose protected vaults, occupied ports and log location without echoing logs", async () => {
  for (const [error, expected] of [["EPERM secret-do-not-echo", "完全磁盘访问权限"], ["EADDRINUSE", "端口 7420 被占用"], ["other", "hub.err.log"]]) {
    const f = await fixture(); const state = join(f.home, ".local/share/lumio"); await mkdir(state, { recursive: true }); await writeFile(join(state, "hub.err.log"), error!);
    let time = 0;
    await expect(setup({ ...f.options, fetch: (async () => { throw new Error(); }), now: () => time, sleep: async (ms) => { time += ms; } })).rejects.toThrow(expected!);
    expect(f.logs.join("\n")).not.toContain("secret-do-not-echo");
  }
});
test("Tailscale is offered only when found, serve and IP choices configure the right interface", async () => {
  for (const mode of ["serve", "ip"]) {
    const f = await fixture();
    await setup({ ...f.options, yes: false, server: true, find: (name) => name === "tailscale" ? "/opt/tailscale" : null,
      ask: async (question, fallback) => question.startsWith("用 Tailscale") ? "yes" : question.startsWith("Tailscale 方式") ? mode : fallback,
      run: async (argv) => { f.commands.push(argv); return { code: 0, stdout: argv.includes("status") ? JSON.stringify({ Self: { DNSName: "synthetic.ts.net.", TailscaleIPs: ["100.64.0.1"] } }) : "", stderr: "" }; },
    });
    const env = parseEnvironment(await readFile(join(f.home, ".config/lumio/hub.env"), "utf8"));
    expect(env.LUMIO_PUBLIC_URL).toBe(mode === "serve" ? "https://synthetic.ts.net" : "http://100.64.0.1:7420");
    expect(env.LUMIO_HUB_LISTEN).toBe(mode === "serve" ? "127.0.0.1:7420" : "100.64.0.1:7420");
  }
  const f = await fixture(); let offered = false;
  await setup({ ...f.options, yes: false, ask: async (question, fallback) => { if (question.includes("Tailscale")) offered = true; return fallback; } }); expect(offered).toBe(false);
});
test("public URL parsing and network warnings follow the actual binding", () => {
  for (const value of ["file:///tmp", "https://user:secret@example.org", "http://example.org/?token=secret"]) expect(() => readConfig({ LUMIO_VAULT: "/synthetic", LUMIO_PUBLIC_URL: value })).toThrow("LUMIO_PUBLIC_URL");
  expect(networkWarning({ hostname: "0.0.0.0", publicUrl: "http://example.org" })).toContain("警告");
  expect(networkWarning({ hostname: "0.0.0.0", publicUrl: undefined })).toContain("警告");
  expect(networkWarning({ hostname: "127.0.0.1", publicUrl: "http://example.org" })).toBeUndefined();
  expect(networkWarning({ hostname: "::1", publicUrl: undefined })).toBeUndefined();
  expect(networkWarning({ hostname: "0.0.0.0", publicUrl: "https://example.org" })).toBeUndefined();
  expect(runtimeName("@@My Mac!")).toBe("my-mac-");
  const values = { PATH: '/a b/"$value`/:/usr/bin', LUMIO_TOKEN: "synthetic" }; expect(parseEnvironment(environmentText(values))).toEqual(values);
});

test("setup connects a real synthetic Hub and local runtime through HTTP without touching host services", async () => {
  const { startHub } = await import("../src/server.ts");
  const f = await fixture();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = probe.port; await probe.stop(true);
  let hub: Awaited<ReturnType<typeof startHub>> | undefined, child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await setup({ ...f.options, env: { ...f.options.env, LUMIO_HUB_LISTEN: `127.0.0.1:${port}`, PATH: join(f.home, "no-agents") }, fetch,
      run: async (argv) => {
        if (argv.includes("bootstrap")) {
          const env = parseEnvironment(await readFile(join(f.home, ".config/lumio/hub.env"), "utf8"));
          hub = await startHub(readConfig(env), { log: () => {} });
        }
        if (argv[0]?.endsWith("lumio-runtime")) {
          child = Bun.spawn([process.execPath, new URL("../../runtime/src/main.ts", import.meta.url).pathname], {
            env: { HOME: f.home, PATH: join(f.home, "no-agents") }, stdout: "pipe", stderr: "pipe",
          });
          for (let i = 0; i < 100; i++) {
            try {
              const info = JSON.parse(await readFile(join(f.home, ".local/share/lumio-runtime/registered.json"), "utf8"));
              if (info.online) return { code: 0, stdout: "已连上 Hub", stderr: "" };
            } catch { /* waiting for first registration */ }
            await Bun.sleep(20);
          }
          throw new Error("runtime registration timeout");
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const config = await f.config();
    const response = await fetch(`${config.hub_url}/v1/runtimes`, { headers: { Authorization: `Bearer ${config.token}` } });
    const runtimes = await response.json() as { online: boolean; registration: { name: string } }[];
    expect(runtimes).toHaveLength(1); expect(runtimes[0]).toMatchObject({ online: true, registration: { name: "my-mac.local" } });
  } finally { if (child) { child.kill(); await child.exited; } await hub?.stop(); }
});


test("noninteractive setup explains selected defaults and how to change them without prompting", async () => {
  const f = await fixture();
  await setup({ ...f.options, yes: false, interactive: false, server: true,
    find: () => "/synthetic/tailscale", ask: async () => { throw new Error("must not prompt"); },
  });
  const output = f.logs.join("\n");
  for (const text of ["没有交互终端", "采用默认值", "lumio-hub setup --vault <路径>", "lumio-hub setup --server", `vault=${f.home}/.config/lumio/vault`, "监听=0.0.0.0:7420", "对外地址=未设置", "Tailscale 不自动启用"]) expect(output).toContain(text);
  expect(f.commands.some((argv) => argv[0]?.includes("tailscale"))).toBe(false);
});

test("service files preserve shared directory permissions while configs remain private, even under umask 077", async () => {
  for (const platform of ["darwin", "linux"]) {
    const f = await fixture(platform);
    const shared = join(f.home, platform === "darwin" ? "Library/LaunchAgents" : ".config/systemd/user");
    await mkdir(shared, { recursive: true }); await chmod(shared, 0o751);
    const path = join(shared, platform === "darwin" ? "io.lumio.hub.plist" : "lumio-hub.service");
    await writeFile(path, "old service"); await chmod(path, 0o666);
    const mask = process.umask(0o077);
    try { await setup(f.options); } finally { process.umask(mask); }
    expect((await stat(shared)).mode & 0o777).toBe(0o751);
    expect((await stat(path)).mode & 0o777).toBe(platform === "darwin" ? 0o600 : 0o644);
    expect((await stat(join(f.home, ".config/lumio"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.home, ".config/lumio/config.json"))).mode & 0o777).toBe(0o600);
  }
});

test("source setup and install-service reject the Bun interpreter before writing any files", async () => {
  for (const [entry, command] of [["../src/main.ts", "setup"], ["../../runtime/src/main.ts", "install-service"]]) {
    const f = await fixture();
    const child = Bun.spawn([process.execPath, new URL(entry!, import.meta.url).pathname, command!], {
      env: { HOME: f.home, PATH: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(output).toBe(""); expect(error).toContain("请用 install.sh 安装的程序运行");
    for (const path of [".config/lumio", ".config/lumio-runtime", ".local/share/lumio", ".local/share/lumio-runtime", "Library/LaunchAgents"]) {
      await expect(stat(join(f.home, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
  }
});

test("single-machine setup never asks about Tailscale; --public-url sets the address without changing the binding (P2-11)", async () => {
  const f = await fixture(); const asked: string[] = [];
  await setup({ ...f.options, yes: false, publicUrl: "https://mac.synthetic.ts.net", find: (name) => name === "tailscale" ? "/opt/tailscale" : null,
    ask: async (question, fallback) => { asked.push(question); return fallback; } });
  expect(asked.some((q) => q.includes("Tailscale"))).toBe(false);
  const env = parseEnvironment(await readFile(join(f.home, ".config/lumio/hub.env"), "utf8"));
  expect(env.LUMIO_PUBLIC_URL).toBe("https://mac.synthetic.ts.net");
  expect(env.LUMIO_HUB_LISTEN).toBe("127.0.0.1:7420");
  asked.length = 0;
  await setup({ ...f.options, yes: false, find: (name) => name === "tailscale" ? "/opt/tailscale" : null, ask: async (question, fallback) => { asked.push(question); return fallback; } });
  expect(asked.some((q) => q.includes("Tailscale"))).toBe(false);
  expect(parseEnvironment(await readFile(join(f.home, ".config/lumio/hub.env"), "utf8")).LUMIO_PUBLIC_URL).toBe("https://mac.synthetic.ts.net"); // 重跑沿用
});

