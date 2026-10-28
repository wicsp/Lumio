#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { setup } from "./setup.ts";
import { version } from "./version.ts";
import { runManagement } from "./cli.ts";
import { readConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { startHub } from "./server.ts";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") console.log(version);
  else if (args[0] === "setup") {
    const { values, positionals } = parseArgs({ args: args.slice(1), options: { vault: { type: "string" }, server: { type: "boolean" }, yes: { type: "boolean" }, "public-url": { type: "string" } } });
    if (positionals.length) throw new HubError("INVALID", "用法：lumio-hub setup [--vault 路径] [--server] [--public-url 地址] [--yes]");
    const { "public-url": publicUrl, ...rest } = values;
    await setup({ ...rest, ...(publicUrl !== undefined ? { publicUrl } : {}) });
  }
  else if (args.length) await runManagement(args);
  else {
    const hub = await startHub(readConfig());
    const shutdown = () => { void hub.stop(); };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
} catch (cause) {
  // Never echo argv, headers or database exceptions, which may contain credentials.
  const code = (cause as NodeJS.ErrnoException).code;
  console.error(cause instanceof HubError ? cause.message : ["EPERM", "EACCES", "EADDRINUSE"].includes(code ?? "") ? `Hub 启动失败：${code}` : "Hub 无法启动或执行命令；请检查命令参数、LUMIO_VAULT、LUMIO_STATE_DIR、LUMIO_HUB_LISTEN 和 LUMIO_TRUSTED_PROXY");
  process.exitCode = 1;
}
