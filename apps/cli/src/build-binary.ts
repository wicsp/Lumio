import { errorMessage, text as msg } from "./messages.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildWebAssets } from "../../web/src/entry.ts";
import { RELEASE_PUBLIC_KEYS, releaseShim } from "@lumio/platform";

export interface BinaryOptions { outfile: string; target?: string; version?: string }
/** The release tarball keeps three regular files so the v0.1.x upgrader can install it. */
export async function writeReleaseShims(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const role of ["hub", "runtime"] as const) await writeFile(join(directory, `lumio-${role}`), releaseShim(role), { mode: 0o755, flag: "wx" });
}
/** Build browser assets once and import their text into the compiled program (#66). */
export async function buildBinary(options: BinaryOptions): Promise<void> {
  if (options.version !== undefined && !/^\d+\.\d+\.\d+([.-][a-zA-Z0-9.-]+)?$/.test(options.version)) throw new Error(msg("build-binary.version_must_be_x_y_z"));
  if (options.target !== undefined && !/^bun-(darwin-arm64|linux-x64|linux-arm64)$/.test(options.target)) throw new Error(msg("build-binary.unsupported_build_target"));
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
    const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: { outfile: { type: "string" }, target: { type: "string" }, version: { type: "string" }, "release-shims": { type: "boolean" } } });
    if (positionals.length || !values.outfile) throw new Error(msg("build-binary.usage_build_binary_ts_outfile_path_target_bun_platform_version_x_y_z"));
    if (values["release-shims"] && !resolve(values.outfile).endsWith("/lumio")) throw new Error(msg("build-binary.output_file_must_be_named_lumio_when_generating_release_shims"));
    await buildBinary({ outfile: values.outfile, ...(values.target ? { target: values.target } : {}), ...(values.version ? { version: values.version } : {}) });
    if (values["release-shims"]) await writeReleaseShims(dirname(resolve(values.outfile)));
  } catch (cause) { console.error(cause instanceof Error ? errorMessage(cause) : msg("build-binary.build_failed")); process.exitCode = 1; }
}
