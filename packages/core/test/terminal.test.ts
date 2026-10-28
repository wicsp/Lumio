import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askTerminal, openTerminal } from "../src/terminal.ts";

// P2-11：在真实伪终端里问答。`curl … | sh` 时标准输入是管道，问题必须经 /dev/tty 读写。
const script = Bun.which("script");
const index = new URL("../src/index.ts", import.meta.url).pathname;

test("without a terminal it reports non-interactive instead of blocking", () => {
  expect(openTerminal("/nonexistent/tty")).toBeUndefined();
  expect(askTerminal({ path: "/nonexistent/tty" }, "?")).toBeUndefined();
});

test.skipIf(!script)("inside a real pseudo-terminal, with stdin a pipe, the answer typed at the terminal is read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumio-tty-"));
  try {
    const program = join(dir, "ask.ts"), out = join(dir, "answer.txt");
    await writeFile(program, `import { askTerminal, openTerminal } from ${JSON.stringify(index)};
const t = openTerminal(); if (!t) { await Bun.write(${JSON.stringify(out)}, "NO-TTY"); process.exit(0); }
const a = askTerminal(t, "vault 路径 [默认]："), b = askTerminal(t, "确认？输入 yes：");
await Bun.write(${JSON.stringify(out)}, JSON.stringify([a, b]));\n`);
    // 子进程的标准输入是管道（与 curl | sh 相同），只能从终端读到回答。
    const command = `echo piped-stdin | ${JSON.stringify(process.execPath)} ${JSON.stringify(program)}`;
    const args = process.platform === "darwin" ? [script!, "-q", "/dev/null", "sh", "-c", command] : [script!, "-q", "-e", "-c", command, "/dev/null"];
    const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    await Bun.sleep(1500);
    child.stdin.write("/tmp/我的 vault\n"); child.stdin.flush();
    await Bun.sleep(300);
    child.stdin.write("yes\n"); child.stdin.flush(); child.stdin.end();
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(output).toContain("vault 路径 [默认]：");
    expect(JSON.parse(await Bun.file(out).text())).toEqual(["/tmp/我的 vault", "yes"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
