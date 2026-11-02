/**
 * 编译 lumio-web 单程序（ADR 0027、R1-1）：先构建浏览器资源，再以文本方式嵌入编译入口。
 * 编译出的程序运行时不调用 Bun.build，也不读取仓库源码。
 *
 *   bun run build:binary -- --outfile dist/lumio-web [--target bun-darwin-arm64] [--version 0.2.0]
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildAssets } from "./build.ts";

export interface BinaryOptions { outfile: string; target?: string; version?: string }

export async function buildBinary(options: BinaryOptions): Promise<void> {
  if (options.version !== undefined && !/^[0-9]+\.[0-9]+\.[0-9]+([.-][a-zA-Z0-9.-]+)?$/.test(options.version)) throw new Error("版本应为 X.Y.Z");
  if (options.target !== undefined && !/^bun-[a-z0-9-]+$/.test(options.target)) throw new Error("target 应为 bun-<平台>，例如 bun-darwin-arm64");
  const assets = await buildAssets();
  const work = await mkdtemp(join(tmpdir(), "lumio-web-binary-"));
  try {
    await Bun.write(join(work, "app.js.txt"), assets.js);
    await Bun.write(join(work, "app.css.txt"), assets.css);
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    await Bun.write(join(work, "entry.ts"), [
      `import js from "./app.js.txt" with { type: "text" };`,
      `import css from "./app.css.txt" with { type: "text" };`,
      `import { main } from ${JSON.stringify(main)};`,
      `await main({ js, css });`,
    ].join("\n") + "\n");
    const args = ["build", "--compile", join(work, "entry.ts"), "--outfile", resolve(options.outfile),
      ...(options.target ? [`--target=${options.target}`] : []),
      ...(options.version ? ["--define", `LUMIO_VERSION=${JSON.stringify(options.version)}`] : [])];
    const child = Bun.spawn([process.execPath, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`lumio-web 编译失败：${stderr.trim()}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), options: { outfile: { type: "string" }, target: { type: "string" }, version: { type: "string" } } });
    if (positionals.length || !values.outfile) throw new Error("用法：bun run build:binary -- --outfile <路径> [--target bun-<平台>] [--version X.Y.Z]");
    await buildBinary({ outfile: values.outfile, ...(values.target ? { target: values.target } : {}), ...(values.version ? { version: values.version } : {}) });
    console.log(`已编译 ${values.outfile}`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "编译失败");
    process.exitCode = 1;
  }
}
