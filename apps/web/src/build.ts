/**
 * 浏览器资源构建（ADR 0026）：Bun.build 打包 src/client/main.ts，样式取自 src/client/styles.css。
 * startWeb 启动时构建一次并放在内存里；`bun run build` 把同样的结果写到 dist/ 便于检查。
 */
import { fileURLToPath } from "node:url";
import { basename } from "node:path";

export interface WebAssets { js: string; css: string; chunks?: Record<string, string>; preloads?: string[] }

export class WebBuildError extends Error {
  readonly code = "WEB_BUILD";
  constructor(message: string) { super(message); this.name = "WebBuildError"; }
}

export async function buildAssets(): Promise<WebAssets> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./client/main.ts", import.meta.url))],
    target: "browser", format: "esm", minify: true, splitting: true, metafile: true,
    publicPath: "/assets/", naming: { entry: "app.js", chunk: "chunk-[hash].js" },
  });
  if (!result.success) throw new WebBuildError(`浏览器资源构建失败：${result.logs.map(String).join("\n")}`);
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new WebBuildError("浏览器资源构建没有产出入口文件");
  const css = await Bun.file(fileURLToPath(new URL("./client/styles.css", import.meta.url))).text();
  const chunks: Record<string, string> = {};
  for (const output of result.outputs) {
    if (output.kind === "chunk") chunks[basename(output.path)] = await output.text();
  }
  // Preload static imports with the entry so splitting does not add a round trip on cold visits.
  const eager = new Set([entry.path]);
  for (const path of eager) {
    for (const dependency of result.metafile!.outputs[path]!.imports) {
      if (dependency.kind === "import-statement" && dependency.path in result.metafile!.outputs) eager.add(dependency.path);
    }
  }
  eager.delete(entry.path);
  return { js: await entry.text(), css, chunks, preloads: [...eager].map(path => basename(path)) };
}

if (import.meta.main) {
  try {
    const assets = await buildAssets();
    const dist = fileURLToPath(new URL("../dist/", import.meta.url));
    await Bun.write(`${dist}app.js`, assets.js);
    await Bun.write(`${dist}app.css`, assets.css);
    for (const [name, content] of Object.entries(assets.chunks ?? {})) await Bun.write(dist + name, content);
    console.log(`已写入 ${dist}app.js（${assets.js.length} 字节）与 app.css`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "构建失败");
    process.exitCode = 1;
  }
}
