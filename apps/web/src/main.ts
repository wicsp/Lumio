#!/usr/bin/env bun
/**
 * lumio-web 入口（ADR 0026、0027）。
 * - 开发：`bun start` 即时构建浏览器资源。
 * - 发布：scripts/build-binary.ts 把构建好的资源嵌入，调用 main(assets)，运行时不再构建、不读源码目录。
 */
import type { WebAssets } from "./build.ts";
import { WebConfigError, parseWebConfig } from "./config.ts";
import { startWeb } from "./server.ts";
import { version } from "./version.ts";

export async function main(assets?: WebAssets, argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === "--version") { console.log(version); return; }
  if (argv.length) { console.error("用法：lumio-web [--version]；配置见环境变量 LUMIO_WEB_LISTEN、LUMIO_WEB_HUB_URL、LUMIO_WEB_ORIGINS"); process.exitCode = 1; return; }
  try {
    const config = parseWebConfig(process.env);
    const web = await startWeb(config, assets ? { assets } : {});
    console.log(`Lumio 工作台 ${version}：${web.url}`);
    console.log(`Hub：${config.hubUrl}`);
    const stop = () => { void web.stop().finally(() => process.exit(0)); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    console.error(cause instanceof WebConfigError ? cause.message
      : code === "EADDRINUSE" ? "工作台端口已被占用；请检查是否已有 lumio-web 在运行，或设置 LUMIO_WEB_LISTEN"
      : cause instanceof Error ? cause.message : "工作台启动失败");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
