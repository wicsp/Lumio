import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliConfig, RuntimeInfo } from "@lumio/schema";
import { HubError } from "./errors.ts";
import { runMigration } from "./migrate.ts";
import { optional, parseEnvironment, runCommand } from "./setup.ts";

export interface SwitchOptions {
  home?: string; platform?: string; uid?: number; binary?: string; env?: NodeJS.ProcessEnv;
  run?: typeof runCommand; log?: (line: string) => void;
  ready?: (service: "hub" | "runtime") => Promise<void>;
  retire?: (vault: string, state: string) => Promise<void>;
}
/** Explicitly requested offline transition; never infer service paths from running processes. */
export async function switchLegacy(args: string[], options: SwitchOptions = {}): Promise<void> {
  if (args.length !== 1 || args[0] !== "--retire-legacy") throw new HubError("INVALID", "用法：lumio hub switch --retire-legacy");
  if (!options.binary && !Bun.main.startsWith("/$bunfs/")) throw new HubError("INVALID", "请用已安装的程序运行 switch；从源码运行不会操作后台服务");
  const home = options.home ?? process.env.HOME ?? homedir(), platform = options.platform ?? process.platform;
  const log = options.log ?? console.log, run = options.run ?? runCommand, env = options.env ?? process.env;
  const binary = options.binary ?? process.execPath, bin = dirname(binary);
  const servicePath = (service: string) => join(home, platform === "darwin" ? `Library/LaunchAgents/io.lumio.${service}.plist` : `.config/systemd/user/lumio-${service}.service`);
  if (!["darwin", "linux"].includes(platform) || !await optional(servicePath("hub")) || !await optional(servicePath("runtime"))) {
    throw new HubError("INVALID", "非托管环境：请手动停止 Hub 与本机执行器，prepare-migration 后运行 migrate retire；switch 未执行任何步骤");
  }
  const hubEnv = parseEnvironment(await optional(join(home, ".config/lumio/hub.env")) ?? "");
  const runtimeEnv = parseEnvironment(await optional(join(home, ".config/lumio-runtime/runtime.env")) ?? "");
  const cli = CliConfig.parse(JSON.parse(await optional(join(home, ".config/lumio/config.json")) ?? "{}"));
  const vault = env.LUMIO_VAULT ?? hubEnv.LUMIO_VAULT ?? cli.vault;
  const state = resolve(env.LUMIO_STATE_DIR ?? hubEnv.LUMIO_STATE_DIR ?? join(home, ".local/share/lumio"));
  const runtimeState = runtimeEnv.LUMIO_RUNTIME_STATE_DIR;
  if (!vault || !runtimeState) throw new HubError("INVALID", "setup 配置缺少知识目录或本机执行器状态目录；未停止服务");
  const completed: string[] = [], domain = `gui/${options.uid ?? process.getuid?.() ?? -1}`;
  const service = (name: "hub" | "runtime", start: boolean) => platform === "darwin"
    ? ["launchctl", start ? "bootstrap" : "bootout", domain, servicePath(name)]
    : ["systemctl", "--user", start ? "start" : "stop", `lumio-${name}.service`];
  const ready = options.ready ?? (async (name: "hub" | "runtime") => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${cli.hub_url.replace(/\/+$/, "")}${name === "hub" ? "/health" : "/v1/runtimes"}`, {
          redirect: "error", signal: AbortSignal.timeout(1000), headers: { Authorization: `Bearer ${cli.token}` },
        });
        if (response.ok) {
          const body = await response.json() as { ok?: boolean };
          if (name === "hub" ? body?.ok === true : RuntimeInfo.array().parse(body).some(runtime => runtime.online && runtime.registration.name === runtimeEnv.LUMIO_RUNTIME_NAME)) return;
        }
      } catch { /* a newly started service may not be listening yet */ }
      await Bun.sleep(200);
    }
    throw new HubError("INVALID", name === "hub" ? "Hub 启动超时" : "本机执行器登记超时");
  });
  const command = async (argv: string[]) => { if ((await run(argv)).code) throw new HubError("INVALID", "命令未成功；请检查服务状态与日志"); };
  async function step(label: string, action: () => Promise<void>) {
    log(`切换：${label}`); await action(); completed.push(label);
  }
  try {
    await step("停止 Hub", () => command(service("hub", false)));
    await step("停止本机执行器", () => command(service("runtime", false)));
    await step("准备本机执行器", () => command([join(bin, "lumio-runtime"), "prepare-migration", "--state-dir", runtimeState]));
    await step("完整备份、验证并退役旧笔记", () => options.retire ? options.retire(vault, state) : runMigration(["retire", "--vault", vault], log, { stateDir: state }));
    await step("启动 Hub", async () => { await command(service("hub", true)); await ready("hub"); });
    await step("启动本机执行器", async () => { await command(service("runtime", true)); await ready("runtime"); });
    await step("运行 doctor", () => command([join(bin, "lumio"), "doctor"]));
    log("切换完成：旧笔记只作知识文件，任务与例行任务请在数据库中管理。");
  } catch (cause) {
    const detail = cause instanceof HubError ? cause.message : "步骤失败";
    throw new HubError("INVALID", `切换已停止：${detail}。已完成：${completed.join(" → ") || "无"}。未继续后续步骤。恢复：先修复失败原因；退役回执写入前可按原配置启动服务，写入后不要再次退役；需要回退时按 docs/migration-v2.md 将退役前备份恢复到新状态目录。启动命令：${service("hub", true).join(" ")}；${service("runtime", true).join(" ")}；然后 lumio doctor。`);
  }
}
