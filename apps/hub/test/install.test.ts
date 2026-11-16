import { beforeEach as beforeLocale, afterEach as afterLocale } from "bun:test";
let previousLocale: string | undefined;
beforeLocale(() => { previousLocale = process.env.LUMIO_LANG; process.env.LUMIO_LANG = "zh"; });
afterLocale(() => { if (previousLocale === undefined) delete process.env.LUMIO_LANG; else process.env.LUMIO_LANG = previousLocale; });
import { signManifest } from "@lumio/platform";
import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, lstat, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const installSource = new URL("../../../install.sh", import.meta.url).pathname;
test("POSIX installer verifies synthetic HTTP releases, forwards setup and join arguments, and preserves programs on verification failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-install-")); roots.push(root);
  const key = generateKeyPairSync("ed25519");
  const privateKey = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const installer = join(root, "install.sh");
  await writeFile(installer, (await readFile(installSource, "utf8")).replace(/^release_key=.*$/m, `release_key=${publicKey}`));
  const archiveDir = join(root, "archive"), tools = join(root, "tools"), home = join(root, "home");
  await mkdir(archiveDir); await mkdir(tools); await mkdir(home);
  await writeFile(join(tools, "uname"), '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$TEST_OS";; -m) printf "%s\\n" "$TEST_ARCH";; esac\n', { mode: 0o755 });
  await writeFile(join(tools, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/curl-args"\nprintf "END\\n" >> "$HOME/curl-args"\n[ "${TEST_CURL_FAIL-}" != yes ] || exit 28\nexec "$TEST_REAL_CURL" "$@"\n', { mode: 0o755 });
  for (const name of ["lumio"]) await writeFile(join(archiveDir, name), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.2.3\\n"; exit; fi\nprintf "%s\\n" "$@" > "$HOME/called-$(basename "$0")"\nif [ -t 0 ]; then printf tty; else printf pipe; fi > "$HOME/stdin-$(basename "$0")"\n', { mode: 0o755 });
  const archive = join(root, "lumio-linux-x64.tar.gz");
  const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", archiveDir, "lumio"]); expect(tar.exitCode).toBe(0);
  let content = await readFile(archive), hash = createHash("sha256").update(content).digest("hex");
  const requests: string[] = []; let corrupt = false, badSignature = false, head: "size" | "unknown" | "reject" = "size";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    const manifest = Buffer.from(JSON.stringify({ format: 1, version: "1.2.3", channel: "release", commit: "0".repeat(40),
      created: "2026-11-16T00:00:00Z", artifacts: [{ platform: "linux-x64", file: "lumio-linux-x64.tar.gz", size: content.length, sha256: corrupt ? "0".repeat(64) : hash }] }));
    if (path.endsWith("/manifest.json")) return new Response(manifest);
    if (path.endsWith("/manifest.sig")) return new Response(badSignature ? "invalid" : signManifest(manifest, privateKey));
    if (request.method === "HEAD" && head !== "size") return new Response(null, { status: head === "reject" ? 405 : 200 });
    return new Response(request.method === "HEAD" ? null : content, { headers: { "Accept-Language": "zh", "Content-Length": String(content.length) } });
  } });
  const installEnv = { ...process.env, LANG: "zh_CN.UTF-8", LC_ALL: "", HOME: home, PATH: tools + ":" + process.env.PATH, TEST_REAL_CURL: Bun.which("curl")!, TEST_OS: "Linux", TEST_ARCH: "x86_64", LUMIO_RELEASE_BASE_URL: server.url.href.replace(/\/$/, "") };
  async function install(args: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn(["sh", installer, ...args], { env: { ...installEnv, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, error, code };
  }
  try {
    let result = await install(["--no-setup", "--version", "v1.2.3"]); expect(result.code).toBe(0); expect(requests).toContain("/download/v1.2.3/lumio-linux-x64.tar.gz");
    expect(result.out).toContain("v1.2.3（linux-x64）");
    expect(result.out).toMatch(/（linux-x64） \d+\.\d (B|KB|MB|GB)…/);
    const quietArgs = (await readFile(join(home, "curl-args"), "utf8")).split("END\n");
    for (const args of quietArgs.slice(3, 4)) { expect(args).toContain("-fsSL\n"); expect(args).not.toContain("--progress-bar"); expect(args).toContain("--connect-timeout\n20\n--speed-limit\n1024\n--speed-time\n60\n"); }
    for (const name of ["lumio"]) expect((await stat(join(home, ".local/bin", name))).mode & 0o777).toBe(0o755);
    for (const name of ["lumio-hub", "lumio-runtime"]) await expect(lstat(join(home, ".local/bin", name))).rejects.toThrow();
    result = await install([]); expect(result.code).toBe(0); expect(await readFile(join(home, "called-lumio"), "utf8")).toBe("hub\nsetup\n");
    result = await install(["--server"]); expect(result.code).toBe(0); expect(await readFile(join(home, "called-lumio"), "utf8")).toBe("hub\nsetup\n--server\n");
    const vault = join(home, "vault with spaces ' and $dollars");
    result = await install(["--server", "--vault", vault]); expect(result.code).toBe(0);
    expect(await readFile(join(home, "called-lumio"), "utf8")).toBe(`hub\nsetup\n--server\n--vault\n${vault}\n`);
    result = await install(["--vault", vault, "--public-url", "https://mac.synthetic.ts.net"]); expect(result.code).toBe(0);
    expect(await readFile(join(home, "called-lumio"), "utf8")).toBe(`hub\nsetup\n--vault\n${vault}\n--public-url\nhttps://mac.synthetic.ts.net\n`);
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
      expect(ttyArgs[3]).toContain("-fL\n--progress-bar\n");
      expect(ttyArgs[1]).toContain("-fsSL\n"); expect(ttyArgs[1]).not.toContain("--progress-bar");
      expect(await readFile(join(home, "stdin-lumio"), "utf8")).toBe("tty");
      expect(await readFile(join(home, "called-lumio"), "utf8")).toBe(`hub\nsetup\n--vault\n${vault}\n`);
    }
    result = await install(["runtime", "--hub", "https://synthetic.example", "--code", "synthetic-pairing-code"]); expect(result.code).toBe(0);
    expect(await readFile(join(home, "called-lumio"), "utf8")).toBe("runtime\njoin\n--hub\nhttps://synthetic.example\n--code\nsynthetic-pairing-code\n");
    expect(result.out + result.error).not.toContain("synthetic-pairing-code");
    result = await install(["--no-setup"], { TEST_CURL_FAIL: "yes" });
    expect(result.code).toBe(1); expect(result.error).toContain("下载发布清单或签名失败");
    await writeFile(join(home, ".local/bin/lumio"), "existing-program"); corrupt = true;
    result = await install(["--no-setup"]); expect(result.code).toBe(1); expect(result.error).toContain("SHA256 校验失败"); expect(await readFile(join(home, ".local/bin/lumio"), "utf8")).toBe("existing-program");
    corrupt = false;
    badSignature = true;
    result = await install(["--no-setup"]); expect(result.code).toBe(1); expect(result.error).toContain("发布清单签名无效");
    expect(await readFile(join(home, ".local/bin/lumio"), "utf8")).toBe("existing-program");
    badSignature = false;
    await writeFile(join(archiveDir, "extra"), "unexpected");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", archiveDir, "lumio", "extra"]).exitCode).toBe(0);
    const valid = content, validHash = hash;
    content = await readFile(archive); hash = createHash("sha256").update(content).digest("hex");
    result = await install(["--no-setup"]); expect(result.code).toBe(1); expect(result.error).toContain("压缩包内容不合法");
    expect(await readFile(join(home, ".local/bin/lumio"), "utf8")).toBe("existing-program");
    content = valid; hash = validHash;
    for (const mode of ["unknown", "reject"] as const) {
      head = mode;
      result = await install(["--no-setup"]);
      expect(result.out).toContain("下载 Lumio 最新版本（linux-x64）…");
      expect(result.out).not.toMatch(/（linux-x64） \d/);
    }
    result = await install([], { TEST_OS: "Darwin", TEST_ARCH: "x86_64" }); expect(result.code).toBe(1); expect(result.error).toContain("不支持的平台");
  } finally { await server.stop(true); }
});
