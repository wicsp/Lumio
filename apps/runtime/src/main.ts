#!/usr/bin/env bun
import { joinRuntime } from "./pairing.ts";
import { configureSudoEnvironment, installSudoHelper } from "./sudo-install.ts";
import { installService, runtimeEnvironment } from "./service.ts";
import { version } from "./version.ts";
import { runSudo } from "./sudo.ts";
import { runSudoHelper } from "./sudo-helper.ts";
import { readConfig, RuntimeError } from "./config.ts";
import { runRuntime } from "./runtime.ts";
import { runWorker } from "./worker.ts";

if (process.argv[2] === "--version") {
  console.log(version);
} else if (process.argv[2] === "join" || process.argv[2] === "install-sudo-helper") {
  try {
    if (process.argv[2] === "join") await joinRuntime(process.argv.slice(3));
    else await installSudoHelper(process.argv.slice(3));
  } catch (cause) { console.error(cause instanceof RuntimeError ? cause.message : "执行器安装失败，请检查配置与权限"); process.exitCode = 1; }
} else if (process.argv[2] === "--configure-sudo-helper") {
  try {
    if (process.getuid?.() === 0 || !process.env.HOME || process.argv.length > 4) throw new RuntimeError("请通过提权助手安装命令更新配置");
    await configureSudoEnvironment(process.env.HOME, process.argv[3]);
  } catch { console.error("无法更新执行器提权配置"); process.exitCode = 1; }
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
  console.error("未知执行器命令");
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
