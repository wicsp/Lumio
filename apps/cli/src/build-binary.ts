import { errorMessage, text as msg } from "./messages.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildWebAssets } from "../../web/src/entry.ts";
import { RELEASE_PUBLIC_KEYS } from "@lumio/platform";

export interface BinaryOptions { outfile: string; target?: string; version?: string }
/** Build browser assets once and import their text into the compiled program (#66). */
export async function buildBinary(options: BinaryOptions): Promise<void> {
  if (options.version !== undefined && !/^\d+\.\d+\.\d+([.-][a-zA-Z0-9.-]+)?$/.test(options.version)) throw new Error(msg("build-binary.version_must_be_x_y_z"));
  if (options.target !== undefined && !/^bun-(darwin-arm64|linux-x64|linux-arm64)$/.test(options.target)) throw new Error(msg("build-binary.unsupported_build_target"));
  const assets = await buildWebAssets(), work = await mkdtemp(join(tmpdir(), "lumio-binary-"));
  try {
    await Bun.write(join(work, "web-assets.json"), JSON.stringify(assets));
    await Bun.write(join(work, "entry.ts"), [
      'import assets from "./web-assets.json" with { type: "json" };',
      `import { main } from ${JSON.stringify(fileURLToPath(new URL("./main.ts", import.meta.url)))};`,
      'await main(assets);',
    ].join("\n") + "\n");
    const child = Bun.spawn([process.execPath, "build", "--compile", join(work, "entry.ts"), "--outfile", resolve(options.outfile),
      ...(options.target ? [`--target=${options.target}`] : []),
      ...(options.version ? ["--define", `LUMIO_VERSION=${JSON.stringify(options.version)}`] : []),
      "--define", `LUMIO_RELEASE_PUBLIC_KEYS=${JSON.stringify(RELEASE_PUBLIC_KEYS)}`,
    ], { stdout: "pipe", stderr: "pipe" });
    const [, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(msg("build-binary.lumio_build_failed", stderr.trim()));
    // Bun modifies its Mach-O image when embedding the bundle; macOS requires a fresh signature.
    if (process.platform === "darwin" && (!options.target || options.target === "bun-darwin-arm64")) {
      const signed = Bun.spawn(["codesign", "--force", "--sign", "-", resolve(options.outfile)], { stdout: "ignore", stderr: "pipe" });
      const [error, code] = await Promise.all([new Response(signed.stderr).text(), signed.exited]);
      if (code) throw new Error(msg("build-binary.lumio_local_signing_failed", error.trim()));
    }
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: { outfile: { type: "string" }, target: { type: "string" }, version: { type: "string" } } });
    if (positionals.length || !values.outfile) throw new Error(msg("build-binary.usage_build_binary_ts_outfile_path_target_bun_platform_version_x_y_z"));
    await buildBinary({ outfile: values.outfile, ...(values.target ? { target: values.target } : {}), ...(values.version ? { version: values.version } : {}) });
  } catch (cause) { console.error(cause instanceof Error ? errorMessage(cause) : msg("build-binary.build_failed")); process.exitCode = 1; }
}
