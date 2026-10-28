import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const installer = new URL("../../../install.sh", import.meta.url).pathname;
test("POSIX installer verifies synthetic HTTP releases, forwards setup/join arguments, and never replaces binaries on checksum failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-install-")); roots.push(root);
  const archiveDir = join(root, "archive"), tools = join(root, "tools"), home = join(root, "home");
  await mkdir(archiveDir); await mkdir(tools); await mkdir(home);
  await writeFile(join(tools, "uname"), '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$TEST_OS";; -m) printf "%s\\n" "$TEST_ARCH";; esac\n', { mode: 0o755 });
  for (const name of ["lumio", "lumio-hub", "lumio-runtime"]) await writeFile(join(archiveDir, name), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/called-$(basename "$0")"\n', { mode: 0o755 });
  const archive = join(root, "lumio-linux-x64.tar.gz");
  const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", archiveDir, "lumio", "lumio-hub", "lumio-runtime"]); expect(tar.exitCode).toBe(0);
  const content = await readFile(archive), hash = createHash("sha256").update(content).digest("hex");
  const requests: string[] = []; let corrupt = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    if (path.endsWith("/SHA256SUMS")) return new Response(`${corrupt ? "0".repeat(64) : hash}  lumio-linux-x64.tar.gz\n`);
    return new Response(content);
  } });
  async function install(args: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn(["sh", installer, ...args], { env: { ...process.env, HOME: home, PATH: tools + ":" + process.env.PATH, TEST_OS: "Linux", TEST_ARCH: "x86_64", LUMIO_RELEASE_BASE_URL: server.url.href.replace(/\/$/, ""), ...extra }, stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, error, code };
  }
  try {
    let result = await install(["--no-setup", "--version", "v1.2.3"]); expect(result.code).toBe(0); expect(requests).toContain("/download/v1.2.3/lumio-linux-x64.tar.gz");
    for (const name of ["lumio", "lumio-hub", "lumio-runtime"]) expect((await stat(join(home, ".local/bin", name))).mode & 0o777).toBe(0o755);
    result = await install([]); expect(result.code).toBe(0); expect(await readFile(join(home, "called-lumio-hub"), "utf8")).toBe("setup\n");
    result = await install(["--server"]); expect(result.code).toBe(0); expect(await readFile(join(home, "called-lumio-hub"), "utf8")).toBe("setup\n--server\n");
    result = await install(["runtime", "--hub", "https://synthetic.example", "--code", "synthetic-pairing-code"]); expect(result.code).toBe(0);
    expect(await readFile(join(home, "called-lumio-runtime"), "utf8")).toBe("join\n--hub\nhttps://synthetic.example\n--code\nsynthetic-pairing-code\n");
    expect(result.out + result.error).not.toContain("synthetic-pairing-code");
    await writeFile(join(home, ".local/bin/lumio"), "existing-program"); corrupt = true;
    result = await install(["--no-setup"]); expect(result.code).toBe(1); expect(result.error).toContain("SHA256 校验失败"); expect(await readFile(join(home, ".local/bin/lumio"), "utf8")).toBe("existing-program");
    result = await install([], { TEST_OS: "Darwin", TEST_ARCH: "x86_64" }); expect(result.code).toBe(1); expect(result.error).toContain("不支持的平台");
  } finally { await server.stop(true); }
});
