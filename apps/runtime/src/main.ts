#!/usr/bin/env bun
import { installService, runtimeEnvironment } from "./service.ts";
import { version } from "./version.ts";
import { runSudo } from "./sudo.ts";
import { runSudoHelper } from "./sudo-helper.ts";
import { readConfig, RuntimeError } from "./config.ts";
import { runRuntime } from "./runtime.ts";
import { runWorker } from "./worker.ts";

if (process.argv[2] === "--version") {
  console.log(version);
} else if (process.argv[2] === "install-service") {
  try { await installService(); }
  catch (cause) { console.error(cause instanceof RuntimeError ? cause.message : "执行器服务安装失败，请检查 runtime.env 与服务日志"); process.exitCode = 1; }
} else if (process.argv[2] === "--job-worker") {
  await runWorker();
} else if (process.argv[2] === "--sudo-helper") {
  process.exitCode = await runSudoHelper();
} else if (process.argv[2] === "sudo") {
  process.exitCode = await runSudo(process.argv.slice(3));
} else if (process.argv.length > 2) {
  console.error("未知执行器命令（join 配对将在 P2-8 提供）");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    const env = await runtimeEnvironment();
    await runRuntime(readConfig(env), { signal: controller.signal, env });
  }
  catch (cause) {
    // Never print fetch exceptions, environment values or agent output.
    console.error(cause instanceof RuntimeError ? cause.message : "执行器无法启动；请检查配置与状态目录权限");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}
