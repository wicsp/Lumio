#!/usr/bin/env bun
import { readConfig, RuntimeError } from "./config.ts";
import { runRuntime } from "./runtime.ts";
import { runWorker } from "./worker.ts";

if (process.argv[2] === "--job-worker") {
  await runWorker();
} else {
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try { await runRuntime(readConfig(), { signal: controller.signal }); }
  catch (cause) {
    // Never print fetch exceptions, environment values or agent output.
    console.error(cause instanceof RuntimeError ? cause.message : "执行器无法启动；请检查配置与状态目录权限");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}
