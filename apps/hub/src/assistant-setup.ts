import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { askTerminal, openTerminal } from "@lumio/platform";
import { modelConfiguration } from "./assistant-model.ts";
import { HubError } from "./errors.ts";
import { atomicFile, environmentText, optional, parseEnvironment, runCommand, xml } from "./setup.ts";

/** Always restore the terminal mode, including on EOF or input errors. */
export function hiddenKey(): string {
  const terminal = openTerminal();
  if (!terminal) throw new HubError("INVALID", "无交互终端；请用 --api-key-stdin 从标准输入读取密钥");
  const fd = openSync(terminal.path, "r+");
  let mode: string | undefined;
  try {
    const saved = Bun.spawnSync(["stty", "-g"], { stdin: fd, stdout: "pipe", stderr: "ignore" });
    if (saved.exitCode) throw new Error();
    mode = saved.stdout.toString().trim();
    if (Bun.spawnSync(["stty", "-echo"], { stdin: fd, stderr: "ignore" }).exitCode) throw new Error();
    return askTerminal(terminal, "API 密钥（不回显；无需密钥可留空）：") ?? "";
  } catch { throw new HubError("INVALID", "无法安全读取密钥；请用 --api-key-stdin"); }
  finally {
    if (mode) Bun.spawnSync(["stty", mode], { stdin: fd, stderr: "ignore" });
    closeSync(fd); process.stderr.write("\n");
  }
}
export interface AssistantSetupOptions {
  home?: string; platform?: string; uid?: number; log?: (line: string) => void;
  run?: typeof runCommand; fetch?: typeof fetch; timeoutMs?: number;
  ask?: (question: string) => Promise<string>; key?: () => Promise<string>; stdin?: () => Promise<string>;
}

export async function restartHubEnvironment(env: Record<string, string>, options: AssistantSetupOptions): Promise<void> {
  const home = options.home ?? process.env.HOME ?? homedir(), platform = options.platform ?? process.platform;
  const log = options.log ?? console.log, run = options.run ?? runCommand;
  const path = join(home, platform === "darwin" ? "Library/LaunchAgents/io.lumio.hub.plist" : ".config/systemd/user/lumio-hub.service");
  const service = await optional(path);
  if (!service || !["darwin", "linux"].includes(platform)) { log("配置已保存；当前非托管环境，请手动重启 Hub 并加载 hub.env。"); return; }
  if (platform === "darwin") {
    const pattern = /(<key>EnvironmentVariables<\/key>\s*<dict>)[\s\S]*?(<\/dict>)/;
    if (!pattern.test(service)) throw new HubError("INVALID", "Hub 服务文件无法更新；请重新运行 setup");
    const entries = Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
    await atomicFile(path, service.replace(pattern, (_all, start, end) => `${start}${entries}${end}`), 0o600);
    if ((await run(["plutil", "-lint", path])).code) throw new HubError("INVALID", "Hub 服务文件校验失败；配置已保存，请重新运行 setup");
    const domain = `gui/${options.uid ?? process.getuid?.() ?? -1}`;
    await run(["launchctl", "bootout", domain, path]);
    if ((await run(["launchctl", "bootstrap", domain, path])).code) throw new HubError("INVALID", "配置已保存，但 Hub 重启失败；请重新运行 setup");
  } else if ((await run(["systemctl", "--user", "restart", "lumio-hub.service"])).code) {
    throw new HubError("INVALID", "配置已保存，但 Hub 重启失败；请手动重启 lumio-hub.service");
  }
  log("Hub 已重启。");
}

export async function assistantConfiguration(args: string[], options: AssistantSetupOptions = {}): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "base-url": { type: "string" }, model: { type: "string" }, "api-key-stdin": { type: "boolean" }, "skip-check": { type: "boolean" },
  } });
  const action = positionals[0];
  if (positionals.length !== 1 || !["setup", "status", "clear"].includes(action ?? "") || (action !== "setup" && Object.keys(values).length)) {
    throw new HubError("INVALID", "用法：lumio hub assistant setup [--base-url 地址 --model 名称 --api-key-stdin --skip-check]；assistant status；assistant clear");
  }
  const log = options.log ?? console.log, home = options.home ?? process.env.HOME ?? homedir();
  const path = join(home, ".config/lumio/hub.env"), env = parseEnvironment(await optional(path) ?? "");
  if (action === "status") {
    const key = env.LUMIO_ASSISTANT_API_KEY;
    const safe = (text: string) => key ? text.replaceAll(key, "[已隐藏]") : text;
    log(`地址：${safe(env.LUMIO_ASSISTANT_BASE_URL ?? "未设置")}\n模型：${safe(env.LUMIO_ASSISTANT_MODEL ?? "未设置")}\n密钥：${key ? "已设置" : "未设置"}`); return;
  }
  if (action === "clear") {
    for (const key of ["LUMIO_ASSISTANT_BASE_URL", "LUMIO_ASSISTANT_MODEL", "LUMIO_ASSISTANT_API_KEY"]) delete env[key];
  } else {
    const terminal = options.ask ? undefined : openTerminal();
    const ask = options.ask ?? (async (question: string) => {
      if (!terminal) throw new HubError("INVALID", "非交互模式需要 --base-url、--model 与 --api-key-stdin");
      return askTerminal(terminal, question) ?? "";
    });
    if (!values["api-key-stdin"] && !options.key && !terminal && !options.ask) throw new HubError("INVALID", "非交互模式必须用 --api-key-stdin");
    const base = values["base-url"] ?? await ask("API 地址（如 https://api.openai.com/v1 或 http://127.0.0.1:8080/v1）：");
    const model = values.model ?? await ask("模型名称：");
    const key = values["api-key-stdin"] ? await (options.stdin ?? (() => Bun.stdin.text()))() : await (options.key ?? (async () => hiddenKey()))();
    const candidate = { LUMIO_ASSISTANT_BASE_URL: base.trim(), LUMIO_ASSISTANT_MODEL: model.trim(), LUMIO_ASSISTANT_API_KEY: key.replace(/\r?\n$/, "") };
    if (Object.values(candidate).some(value => /[\r\n\0]/.test(value))) throw new HubError("INVALID", "助手配置不能包含换行或 NUL");
    let config;
    try { config = modelConfiguration(candidate); } catch { throw new HubError("INVALID", "请检查模型名称与 API 地址；地址必须是不含凭据、查询或片段的 HTTP(S) 地址"); }
    if (!config) throw new HubError("INVALID", "请填写 API 地址与模型名称");
    if (!values["skip-check"]) {
      const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      let response: Response | undefined;
      try {
        response = await (options.fetch ?? fetch)(`${config.baseUrl}/chat/completions`, { method: "POST", redirect: "error", signal,
          headers: { "Content-Type": "application/json", ...(config.credential() ? { Authorization: `Bearer ${config.credential()}` } : {}) },
          body: JSON.stringify({ model: config.model, stream: false, messages: [{ role: "user", content: "ping" }] }),
        });
        if (!response.ok) throw new HubError("INVALID", response.status === 401 || response.status === 403 ? "鉴权失败（401/403），请检查密钥与权限" : response.status === 404 ? "地址或模型不存在（404），请检查 API 基础路径与模型名称" : response.status >= 500 ? "模型服务错误（5xx），请稍后重试" : "模型服务拒绝请求（4xx），请检查地址与模型名称");
        // A 2xx HTML/error page is not evidence of a working Chat Completions endpoint.
        const reader = response.body?.getReader();
        if (!reader) throw new HubError("INVALID", "模型响应为空，请检查地址与模型名称");
        let text = "";
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); if (text.length > 64 * 1024) throw new Error(); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const body = JSON.parse(text);
        if (!Array.isArray(body?.choices) || !body.choices[0]?.message || body.choices[0].message.role !== "assistant") throw new HubError("INVALID", "模型响应格式不正确，请检查地址与模型名称");
      } catch (cause) {
        if (cause instanceof HubError) throw cause;
        throw new HubError("INVALID", signal.aborted ? "模型验证超时（30 秒），未写入配置" : "无法连接模型服务或响应无效，请检查网络与 API 地址；未写入配置");
      } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    }
    Object.assign(env, candidate, { LUMIO_ASSISTANT_BASE_URL: config.baseUrl });
  }
  await atomicFile(path, environmentText(env), 0o600, true);
  await restartHubEnvironment(env, options);
}
