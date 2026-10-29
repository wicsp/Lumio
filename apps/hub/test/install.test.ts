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
  await writeFile(join(tools, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/curl-args"\nprintf "END\\n" >> "$HOME/curl-args"\n[ "${TEST_CURL_FAIL-}" != yes ] || exit 28\nexec "$TEST_REAL_CURL" "$@"\n', { mode: 0o755 });
  for (const name of ["lumio", "lumio-hub", "lumio-runtime"]) await writeFile(join(archiveDir, name), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/called-$(basename "$0")"\nif [ -t 0 ]; then printf tty; else printf pipe; fi > "$HOME/stdin-$(basename "$0")"\n', { mode: 0o755 });
  const archive = join(root, "lumio-linux-x64.tar.gz");
  const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", archiveDir, "lumio", "lumio-hub", "lumio-runtime"]); expect(tar.exitCode).toBe(0);
  const content = await readFile(archive), hash = createHash("sha256").update(content).digest("hex");
  const requests: string[] = []; let corrupt = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    if (path.endsWith("/SHA256SUMS")) return new Response(`${corrupt ? "0".repeat(64) : hash}  lumio-linux-x64.tar.gz\n`);
    return new Response(content);
  } });
  const installEnv = { ...process.env, HOME: home, PATH: tools + ":" + process.env.PATH, TEST_REAL_CURL: Bun.which("curl")!, TEST_OS: "Linux", TEST_ARCH: "x86_64", LUMIO_RELEASE_BASE_URL: server.url.href.replace(/\/$/, "") };
  async function install(args: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn(["sh", installer, ...args], { env: { ...installEnv, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, error, code };
  }
  try {
    let result = await install(["--no-setup", "--version", "v1.2.3"]); expect(result.code).toBe(0); expect(requests).toContain("/download/v1.2.3/lumio-linux-x64.tar.gz");
    expect(result.out).toContain("v1.2.3（linux-x64）");
    const quietArgs = (await readFile(join(home, "curl-args"), "utf8")).split("END\n");
    for (const args of quietArgs.slice(0, 2)) { expect(args).toContain("-fsSL\n"); expect(args).not.toContain("--progress-bar"); expect(args).toContain("--connect-timeout\n20\n--speed-limit\n1024\n--speed-time\n60\n"); }
    for (const name of ["lumio", "lumio-hub", "lumio-runtime"]) expect((await stat(join(home, ".local/bin", name))).mode & 0o777).toBe(0o755);
    result = await install([]); expect(result.code).toBe(0); expect(await readFile(join(home, "called-lumio-hub"), "utf8")).toBe("setup\n");
    result = await install(["--server"]); expect(result.code).toBe(0); expect(await readFile(join(home, "called-lumio-hub"), "utf8")).toBe("setup\n--server\n");
    const vault = join(home, "vault with spaces ' and $dollars");
    result = await install(["--server", "--vault", vault]); expect(result.code).toBe(0);
    expect(await readFile(join(home, "called-lumio-hub"), "utf8")).toBe(`setup\n--server\n--vault\n${vault}\n`);
    result = await install(["--vault", vault, "--public-url", "https://mac.synthetic.ts.net"]); expect(result.code).toBe(0);
    expect(await readFile(join(home, "called-lumio-hub"), "utf8")).toBe(`setup\n--vault\n${vault}\n--public-url\nhttps://mac.synthetic.ts.net\n`);
    expect((await install(["--vault"])).error).toContain("用法");
    expect((await install(["runtime", "--vault", vault])).error).toContain("用法");
    const script = Bun.which("script");
    if (script) {
      await writeFile(join(home, "curl-args"), "");
      const command = 'cat "$TEST_INSTALLER" | sh -s -- --vault "$TEST_VAULT"';
      const args = process.platform === "darwin" ? [script, "-q", "/dev/null", "sh", "-c", command] : [script, "-q", "-e", "-c", command, "/dev/null"];
      const child = Bun.spawn(args, { env: { ...installEnv, TEST_INSTALLER: installer, TEST_VAULT: vault }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(0);
      const ttyArgs = (await readFile(join(home, "curl-args"), "utf8")).split("END\n");
      expect(ttyArgs[0]).toContain("-fL\n--progress-bar\n");
      expect(ttyArgs[1]).toContain("-fsSL\n"); expect(ttyArgs[1]).not.toContain("--progress-bar");
      expect(await readFile(join(home, "stdin-lumio-hub"), "utf8")).toBe("tty");
      expect(await readFile(join(home, "called-lumio-hub"), "utf8")).toBe(`setup\n--vault\n${vault}\n`);
    }
    result = await install(["runtime", "--hub", "https://synthetic.example", "--code", "synthetic-pairing-code"]); expect(result.code).toBe(0);
    expect(await readFile(join(home, "called-lumio-runtime"), "utf8")).toBe("join\n--hub\nhttps://synthetic.example\n--code\nsynthetic-pairing-code\n");
    expect(result.out + result.error).not.toContain("synthetic-pairing-code");
    result = await install(["--no-setup"], { TEST_CURL_FAIL: "yes" });
    expect(result.code).toBe(1); expect(result.error).toContain("下载太慢或卡住，请检查网络或代理（https_proxy）后重试");
    await writeFile(join(home, ".local/bin/lumio"), "existing-program"); corrupt = true;
    result = await install(["--no-setup"]); expect(result.code).toBe(1); expect(result.error).toContain("SHA256 校验失败"); expect(await readFile(join(home, ".local/bin/lumio"), "utf8")).toBe("existing-program");
    result = await install([], { TEST_OS: "Darwin", TEST_ARCH: "x86_64" }); expect(result.code).toBe(1); expect(result.error).toContain("不支持的平台");
  } finally { await server.stop(true); }
});
