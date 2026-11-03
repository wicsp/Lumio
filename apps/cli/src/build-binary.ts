import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildWebAssets } from "../../web/src/entry.ts";
import { releaseShim } from "@lumio/platform";

export interface BinaryOptions { outfile: string; target?: string; version?: string }
/** The release tarball keeps three regular files so the v0.1.x upgrader can install it. */
export async function writeReleaseShims(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const role of ["hub", "runtime"] as const) await writeFile(join(directory, `lumio-${role}`), releaseShim(role), { mode: 0o755, flag: "wx" });
}
/** Build browser assets once and import their text into the compiled program (#66). */
export async function buildBinary(options: BinaryOptions): Promise<void> {
  if (options.version !== undefined && !/^\d+\.\d+\.\d+([.-][a-zA-Z0-9.-]+)?$/.test(options.version)) throw new Error("版本应为 X.Y.Z");
  if (options.target !== undefined && !/^bun-(darwin-arm64|linux-x64|linux-arm64)$/.test(options.target)) throw new Error("不支持的编译目标");
  const assets = await buildWebAssets(), work = await mkdtemp(join(tmpdir(), "lumio-binary-"));
  try {
    await Bun.write(join(work, "app.js.txt"), assets.js); await Bun.write(join(work, "app.css.txt"), assets.css);
    await Bun.write(join(work, "entry.ts"), [
      'import js from "./app.js.txt" with { type: "text" };',
      'import css from "./app.css.txt" with { type: "text" };',
      `import { main } from ${JSON.stringify(fileURLToPath(new URL("./main.ts", import.meta.url)))};`,
      'await main({ js, css });',
    ].join("\n") + "\n");
    const child = Bun.spawn([process.execPath, "build", "--compile", join(work, "entry.ts"), "--outfile", resolve(options.outfile),
      ...(options.target ? [`--target=${options.target}`] : []),
      ...(options.version ? ["--define", `LUMIO_VERSION=${JSON.stringify(options.version)}`] : []),
    ], { stdout: "pipe", stderr: "pipe" });
    const [, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`Lumio 编译失败：${stderr.trim()}`);
    // Bun modifies its Mach-O image when embedding the bundle; macOS requires a fresh signature.
    if (process.platform === "darwin" && (!options.target || options.target === "bun-darwin-arm64")) {
      const signed = Bun.spawn(["codesign", "--force", "--sign", "-", resolve(options.outfile)], { stdout: "ignore", stderr: "pipe" });
      const [error, code] = await Promise.all([new Response(signed.stderr).text(), signed.exited]);
      if (code) throw new Error(`Lumio 本地签名失败：${error.trim()}`);
    }
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: { outfile: { type: "string" }, target: { type: "string" }, version: { type: "string" }, "release-shims": { type: "boolean" } } });
    if (positionals.length || !values.outfile) throw new Error("用法：build-binary.ts --outfile <路径> [--target bun-<平台>] [--version X.Y.Z] [--release-shims]");
    if (values["release-shims"] && !resolve(values.outfile).endsWith("/lumio")) throw new Error("生成发布垫片时输出文件必须命名为 lumio");
    await buildBinary({ outfile: values.outfile, ...(values.target ? { target: values.target } : {}), ...(values.version ? { version: values.version } : {}) });
    if (values["release-shims"]) await writeReleaseShims(dirname(resolve(values.outfile)));
  } catch (cause) { console.error(cause instanceof Error ? cause.message : "编译失败"); process.exitCode = 1; }
}
