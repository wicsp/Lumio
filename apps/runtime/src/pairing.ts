import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RuntimeJoin, RuntimeJoinRequest } from "@lumio/schema";
import { pair } from "./pairing-feedback.ts";
import { RuntimeError, readConfig } from "./config.ts";
import { installService, parseEnvironment, privateFile, type ServiceOptions } from "./service.ts";

export function environmentText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new RuntimeError("环境配置不能包含换行或 NUL");
    return `${key}="${value.replace(/[\\"$`]/g, "\\$&")}"\n`;
  }).join("");
}
export async function optionalFile(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
}
export function hubAddress(raw: string): string {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch { throw new RuntimeError("Hub 地址必须是无凭据、查询或片段的 HTTP(S) 地址"); }
}
export function warnHttp(url: string, log: (line: string) => void) {
  const parsed = new URL(url);
  if (parsed.protocol === "http:" && !/^(localhost|\[::1\]|127\.\d+\.\d+\.\d+)$/.test(parsed.hostname)) log("警告：Hub 使用 HTTP，令牌会以明文传输");
}
export async function joinRuntime(args: string[], options: ServiceOptions & {
  env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch;
  warn?: (line: string) => void;
  install?: (options: ServiceOptions) => Promise<void>;
} = {}) {
  let values: { hub?: string; code?: string };
  try {
    const parsed = parseArgs({ args, options: { hub: { type: "string" }, code: { type: "string" } } }); values = parsed.values;
  } catch { throw new RuntimeError("用法：lumio-runtime join --hub <地址> --code <配对码>"); }
  if (!values.hub || !RuntimeJoinRequest.safeParse({ code: values.code }).success) throw new RuntimeError("用法：lumio-runtime join --hub <地址> --code <配对码>");
  const env = options.env ?? process.env, home = resolve(options.home ?? env.HOME ?? homedir());
  const url = hubAddress(values.hub), log = options.log ?? console.log;
  warnHttp(url, log);
  const path = join(home, ".config/lumio-runtime/runtime.env");
  const previous = parseEnvironment(await optionalFile(path) ?? "");
  // Validate preserved configuration before consuming a single-use invite.
  const state = resolve(previous.LUMIO_RUNTIME_STATE_DIR ?? join(home, ".local/share/lumio-runtime"));
  environmentText({ ...previous, PATH: env.PATH ?? "/usr/bin:/bin" });
  readConfig({ ...previous, LUMIO_HUB_URL: url, LUMIO_TOKEN: "pending-pairing", LUMIO_RUNTIME_NAME: "pending", LUMIO_RUNTIME_STATE_DIR: state });
  const joined = await pair(url, values.code!, "runtime", RuntimeJoin, options.fetch, options.warn);
  const merged = { ...previous, LUMIO_HUB_URL: url, LUMIO_TOKEN: joined.token, LUMIO_RUNTIME_NAME: joined.name,
    LUMIO_RUNTIME_STATE_DIR: state, PATH: env.PATH ?? "/usr/bin:/bin" };
  readConfig(merged);
  await privateFile(path, environmentText(merged));
  await (options.install ?? installService)({ ...options, home });
}
