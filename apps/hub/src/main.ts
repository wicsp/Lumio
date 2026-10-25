#!/usr/bin/env bun
import { runManagement } from "./cli.ts";
import { readConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { startHub } from "./server.ts";

try {
  const args = process.argv.slice(2);
  if (args.length) await runManagement(args);
  else {
    const hub = await startHub(readConfig());
    const shutdown = () => { void hub.stop(); };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
} catch (cause) {
  // Never echo argv, headers or database exceptions, which may contain credentials.
  console.error(cause instanceof HubError ? cause.message : "Hub 无法启动或执行命令；请检查命令参数、LUMIO_VAULT、LUMIO_STATE_DIR、LUMIO_HUB_LISTEN 和 LUMIO_TRUSTED_PROXY");
  process.exitCode = 1;
}
