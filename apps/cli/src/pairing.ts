import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { askTerminal, openTerminal } from "@lumio/platform";
import { pair, PairingError } from "./pairing-feedback.ts";
import { CliConfig, ClientJoin, ClientJoinRequest } from "@lumio/schema";
import { hubCredentials, readCliConfig } from "./config.ts";

async function confirmOverwrite(): Promise<boolean> {
  const terminal = openTerminal();
  if (!terminal) throw new Error("已有 CLI 配置，请在交互终端确认是否覆盖");
  return (askTerminal(terminal, "已有 CLI 配置，覆盖？输入 yes：") ?? "").trim() === "yes";
}
async function writeConfig(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await chmod(temp, 0o600); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export async function runPairing(args: string[], options: {
  home?: string; log?: (line: string) => void; warn?: (line: string) => void; confirm?: () => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
} = {}): Promise<number> {
  const parse = () => parseArgs({ args, allowPositionals: true, options: {
    name: { type: "string" }, code: { type: "string" }, vault: { type: "string" }, json: { type: "boolean" },
  } });
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(); } catch { throw new Error("配对命令参数不合法，请检查命令、Hub 地址和必填选项"); }
  const { positionals, values } = parsed;
  const [command, action, name] = positionals;
  const home = options.home ?? process.env.HOME ?? homedir(), log = options.log ?? console.log;
  const path = join(home, ".config/lumio/config.json");
  if (command === "login") {
    if (positionals.length !== 2 || !action || !values.code || Object.keys(values).some((k) => !["code", "vault"].includes(k))) throw new Error("用法：lumio login <Hub 地址> --code <配对码> [--vault <本机 vault 路径>]");
    let url: URL;
    try { url = new URL(action); } catch { throw new Error("Hub 地址必须是 HTTP(S) 地址"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Hub 地址必须是无凭据、查询或片段的 HTTP(S) 地址");
    let exists = false;
    try { await readFile(path); exists = true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    if (exists && !await (options.confirm ?? confirmOverwrite)()) { log("已取消登录"); return 0; }
    if (url.protocol === "http:" && !/^(localhost|\[::1\]|127\.\d+\.\d+\.\d+)$/.test(url.hostname)) (options.warn ?? console.error)("警告：Hub 使用 HTTP，令牌会以明文传输");
    const hub_url = url.href.replace(/\/+$/, "");
    const request = ClientJoinRequest.safeParse({ code: values.code });
    if (!request.success) throw new PairingError("配对码格式不合法，请重新运行 lumio login-code");
    const joined = await pair(hub_url, request.data.code, "client", ClientJoin, options.fetch, options.warn);
    await writeConfig(path, CliConfig.parse({ hub_url, token: joined.token, ...(values.vault ? { vault: resolve(values.vault) } : {}) }));
    log("CLI 已登录"); return 0;
  }
  if (command === "logout") {
    if (positionals.length !== 1 || Object.keys(values).length) throw new Error("用法：lumio logout");
    try {
      const config = CliConfig.partial({ token: true }).parse(JSON.parse(await readFile(path, "utf8")));
      delete config.token; await writeConfig(path, config);
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CLI 配置无法读取，请检查配置文件"); }
    log("已移除 CLI 配置中的令牌"); return 0;
  }
  if (command === "login-code") {
    if (positionals.length !== 1 || Object.keys(values).some((k) => k !== "name")) throw new Error("用法：lumio login-code [--name cli@<主机名>]");
    const client = createClient({ ...hubCredentials(readCliConfig({ home, warn: options.warn })), fetch: options.fetch });
    log((await client.clientInvite(values.name ?? `cli@${hostname().toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 60)}`)).command); return 0;
  }
  if (command === "runtime" && ["add", "remove"].includes(action ?? "")) {
    if (positionals.length !== 3 || !name || Object.keys(values).some((k) => k !== "json")) throw new Error("用法：lumio runtime add|remove <名称> [--json]");
    const client = createClient({ ...hubCredentials(readCliConfig({ home, warn: options.warn })), fetch: options.fetch });
    if (action === "remove") { await client.removeRuntime(name); log(values.json ? "null" : "已吊销执行器的全部令牌"); }
    else {
      const invite = await client.runtimeInvite(name);
      if (values.json) log(JSON.stringify(invite));
      else { log("在那台机器上运行（10 分钟内有效，只能用一次）："); log(invite.command); }
    }
    return 0;
  }
  throw new Error("未知配对命令");
}
