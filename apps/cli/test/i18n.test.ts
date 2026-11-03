import { expect, test } from "bun:test";
import { CoreError } from "@lumio/foundation";
import { language } from "@lumio/platform";
import { errorMessage } from "../src/messages.ts";

const main = new URL("../src/main.ts", import.meta.url).pathname;
test("the same command follows LANG and LUMIO_LANG overrides it", async () => {
  for (const [env, expected, chinese] of [
    [{ LANG: "en_US.UTF-8" }, "Usage: lumio sync", false],
    [{ LANG: "zh_CN.UTF-8" }, "用法：lumio sync", true],
    [{ LANG: "zh_CN.UTF-8", LUMIO_LANG: "en" }, "Usage: lumio sync", false],
    [{ LANG: "en_US.UTF-8", LUMIO_LANG: "zh" }, "用法：lumio sync", true],
    [{ LANG: "zh_CN.UTF-8", LC_ALL: "en_US.UTF-8" }, "Usage: lumio sync", false],
  ] as const) {
    const child = Bun.spawn([process.execPath, main, "invalid-command"], { env, stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(output).toContain(expected); expect(/\p{Script=Han}/u.test(output)).toBe(chinese);
  }
});
test("libraries preserve codes and parameters and CLI formats them", () => {
  const saved = process.env.LUMIO_LANG;
  const error = new CoreError("FILE_EXISTS", { key: "write.file_already_exists", args: ["synthetic.md"] });
  try {
    expect(error.message).toBe("FILE_EXISTS"); expect(error.code).toBe("FILE_EXISTS");
    process.env.LUMIO_LANG = "en"; expect(errorMessage(error)).toBe("File already exists: synthetic.md");
    process.env.LUMIO_LANG = "zh"; expect(errorMessage(error)).toBe("文件已存在：synthetic.md");
    expect(language()).toBe("zh");
  } finally { if (saved === undefined) delete process.env.LUMIO_LANG; else process.env.LUMIO_LANG = saved; }
});

test("CLI sends its language to Hub and localizes SDK transport failures", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = await mkdtemp(join(tmpdir(), "lumio-cli-language-"));
  const seen: string[] = [];
  let unavailable = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push(request.headers.get("Accept-Language") ?? "");
    return unavailable ? new Response("synthetic invalid response", { status: 503 }) : Response.json([]);
  } });
  try {
    for (const language of ["en", "zh"]) {
      const child = Bun.spawn([process.execPath, main, "task", "list", "--json"], { env: { HOME: home, LUMIO_HUB_URL: server.url.href, LUMIO_TOKEN: "synthetic-token", LUMIO_LANG: language }, stdout: "pipe", stderr: "pipe" });
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(0); expect(JSON.parse(output)).toEqual([]);
    }
    expect(seen).toEqual(["en", "zh"]);
    unavailable = true;
    const child = Bun.spawn([process.execPath, main, "task", "list"], { env: { HOME: home, LUMIO_HUB_URL: server.url.href, LUMIO_TOKEN: "synthetic-token", LANG: "en_US.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    const error = await new Response(child.stderr).text();
    expect(error).toContain("Hub connection failed"); expect(/\p{Script=Han}/u.test(error)).toBe(false);
  } finally { await server.stop(true); await rm(home, { recursive: true, force: true }); }
});

test("schema issue codes and argument parser failures are translated without changing schema", async () => {
  const { fillMetadata } = await import("@lumio/knowledge");
  const { text } = await import("../src/messages.ts");
  const saved = process.env.LUMIO_LANG;
  try {
    for (const lang of ["en", "zh"]) {
      process.env.LUMIO_LANG = lang;
      const result = fillMetadata({ type: "paper", frontmatter: {}, fileName: "synthetic", birthtime: new Date(0), mtime: new Date(0) },
        { now: new Date(0), tz: "UTC", newId: () => "pap_00000000000000000000000001", text });
      expect(result.issues.find(issue => issue.path === "authors")?.message).toBe(lang === "en" ? "Invalid value (invalid_type)" : "值不合法（invalid_type）");
      const error = Object.assign(new Error("synthetic parser detail"), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" });
      expect(errorMessage(error)).toBe(lang === "en" ? "Invalid command arguments; check the command usage" : "命令参数不合法，请检查命令用法");
    }
  } finally { if (saved === undefined) delete process.env.LUMIO_LANG; else process.env.LUMIO_LANG = saved; }
});
