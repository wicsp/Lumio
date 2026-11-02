import { isolatedHome } from "./test-home.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@lumio/knowledge";
import { Paper } from "@lumio/schema";
import { runCli, type CliOptions } from "../src/cli.ts";
import type { PaperFetcher } from "../src/paper-source.ts";
import { fixtureFetcher, paperFixture as fixture } from "./paper-fixtures.ts";
const cliHome = isolatedHome();

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
let vault: string;
beforeEach(async () => { vault = await mkdtemp(join(tmpdir(), "lumio-cli-paper-test-")); });
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

async function run(args: string[], overrides: CliOptions = {}) {
  const output: string[] = [];
  const previousHome = process.env.HOME;
  process.env.HOME = cliHome;
  try {
    const code = await runCli([...args, "--vault", vault], {
      fetcher: fixtureFetcher, log: (line) => output.push(line), ...overrides,
    });
    return { code, output };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

test.each([
  ["2002.02126v2", "He_2020_LightGCN", "2002.02126"],
  ["https://arxiv.org/pdf/2403.14720v2.pdf", "Hines_2024_DAIP", "2403.14720"],
  ["arXiv:2406.13352", "Debenedetti_2024_AgentDojo", "2406.13352"],
  ["https://doi.org/10.1145/3397271.3401063", "He_2020_LightGCN", "doi"],
])("new paper %s passes Paper and sync writes nothing", async (input, citekey, identifier) => {
  const result = await run(["new", "paper", input]);
  expect(result).toEqual({ code: 0, output: [`library/papers/${citekey}.md`] });
  const path = join(vault, "library/papers", `${citekey}.md`);
  const bytes = await readFile(path);
  const parsed = parseFrontmatter(bytes);
  expect(Paper.safeParse(parsed.data).success).toBe(true);
  expect(parsed.data.citekey).toBe(citekey);
  if (identifier !== "doi") expect(parsed.data.arxiv).toBe(identifier);
  else expect(parsed.data.doi).toBe("10.1145/3397271.3401063");
  const before = await stat(path);
  expect(await run(["sync"])).toEqual({ code: 0, output: ["完成：扫描 1 个，补全 0 个，问题 0 个，跳过 0 个"] });
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect((await stat(path)).ino).toBe(before.ino);
  expect(await readdir(vault)).toEqual(["library"]);
});

test("--abbr supplies Spotlighting and changes only the abbreviation", async () => {
  expect(await run(["new", "paper", "2403.14720", "--abbr", "Spotlighting"])).toEqual({ code: 0, output: ["library/papers/Hines_2024_Spotlighting.md"] });
  const parsed = parseFrontmatter(await readFile(join(vault, "library/papers/Hines_2024_Spotlighting.md")));
  expect(parsed.body.toString()).toContain("@misc{Hines_2024_Spotlighting,");
});

test.each([
  ["arxiv", "2002.02126", "2002.02126v3", "--abbr", "Other", "已存在"],
  ["doi", "10.1145/3397271.3401063", "https://doi.org/10.1145/3397271.3401063", "--abbr", "Other", "已存在"],
])("duplicate %s is rejected without overwriting any note", async (_kind, first, second, flag, abbreviation, message) => {
  await run(["new", "paper", first]);
  const files = await readdir(join(vault, "library/papers"));
  const path = join(vault, "library/papers", files[0]!);
  const bytes = await readFile(path);
  const before = await stat(path);
  await expect(run(["new", "paper", second, flag, abbreviation])).rejects.toThrow(message);
  expect(await readdir(join(vault, "library/papers"))).toEqual(files);
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect((await stat(path)).ino).toBe(before.ino);
});

test("a real CLI process with piped stdin adds a paper without flags or reading stdin", async () => {
  const preload = fileURLToPath(new URL("./preload-paper-fetch.ts", import.meta.url));
  const proc = Bun.spawn([process.execPath, "--preload", preload, main, "new", "paper", "2403.14720"], {
    env: { ...process.env, HOME: cliHome, LUMIO_VAULT: vault }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 3000);
  try {
    // Keep stdin open: the command must finish without waiting for confirmation or EOF.
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "library/papers/Hines_2024_DAIP.md\n", stderr: "" });
  } finally { clearTimeout(timeout); proc.stdin.end(); }
  const path = join(vault, "library/papers/Hines_2024_DAIP.md");
  const original = await readFile(path);
  const before = await stat(path);
  expect(Paper.safeParse(parseFrontmatter(original).data).success).toBe(true);
  expect((await run(["sync"])).output).toEqual(["完成：扫描 1 个，补全 0 个，问题 0 个，跳过 0 个"]);
  expect(await readFile(path)).toEqual(original);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect((await stat(path)).ino).toBe(before.ino);
});

test.each(["arXiv API", "arXiv BibTeX", "Crossref", "DOI BibTeX"])("source failure %s writes no files", async (source) => {
  const arxiv = source.startsWith("arXiv");
  const fetcher: PaperFetcher = async (url, init) => {
    const fail = (source === "arXiv API" && url.includes("export.arxiv"))
      || (source === "arXiv BibTeX" && url.includes("/bibtex/"))
      || (source === "Crossref" && url.includes("api.crossref"))
      || (source === "DOI BibTeX" && url.startsWith("https://doi.org/"));
    return fail ? new Response("unavailable", { status: 503 }) : fixtureFetcher(url, init);
  };
  await expect(run(["new", "paper", arxiv ? "2002.02126" : "10.1145/3397271.3401063"], { fetcher })).rejects.toThrow(`${source} 请求失败`);
  expect(await readdir(vault)).toEqual([]);
});

test.each(["invalid XML", "wrong ID", "invalid BibTeX"])("bad source content (%s) writes no files", async (kind) => {
  const fetcher: PaperFetcher = async (url, init) => {
    if (url.includes("export.arxiv")) {
      if (kind === "invalid XML") return new Response("<feed><entry></feed>");
      if (kind === "wrong ID") return new Response(await fixture("2403.14720.xml"));
    } else if (kind === "invalid BibTeX") return new Response("<html>error</html>");
    return fixtureFetcher(url, init);
  };
  await expect(run(["new", "paper", "2002.02126"], { fetcher })).rejects.toThrow();
  expect(await readdir(vault)).toEqual([]);
});

test("a title without ASCII content uses Paper automatically", async () => {
  const xml = (await fixture("2002.02126.xml")).replace(/(<entry>[\s\S]*?<title>)[\s\S]*?(<\/title>)/, "$1---$2");
  const fetcher: PaperFetcher = (url, init) => url.includes("export.arxiv") ? Promise.resolve(new Response(xml)) : fixtureFetcher(url, init);
  expect(await run(["new", "paper", "2002.02126"], { fetcher })).toEqual({ code: 0, output: ["library/papers/He_2020_Paper.md"] });
});

test("a Chinese author and title can be added automatically without an abbreviation", async () => {
  const xml = (await fixture("2002.02126.xml"))
    .replace(/(<entry>[\s\S]*?<title>)[\s\S]*?(<\/title>)/, "$1中文标题$2")
    .replace("<name>Xiangnan He</name>", "<name>张三</name>");
  const fetcher: PaperFetcher = (url, init) => url.includes("export.arxiv") ? Promise.resolve(new Response(xml)) : fixtureFetcher(url, init);
  expect(await run(["new", "paper", "2002.02126"], { fetcher })).toEqual({ code: 0, output: ["library/papers/Anon_2020_Paper.md"] });
  const parsed = parseFrontmatter(await readFile(join(vault, "library/papers/Anon_2020_Paper.md")));
  expect(Paper.safeParse(parsed.data).success).toBe(true);
  expect(parsed.data.title).toBe("中文标题");
  expect((parsed.data.authors as string[])[0]).toBe("张三");
  expect((await run(["sync"])).output).toEqual(["完成：扫描 1 个，补全 0 个，问题 0 个，跳过 0 个"]);
});

test("invalid abbreviation and unsupported input are rejected without writes", async () => {
  await expect(run(["new", "paper", "2002.02126", "--abbr", "!!"])).rejects.toThrow("--abbr 删除非法字符后为空");
  await expect(run(["new", "paper", "unsupported"])).rejects.toThrow("接受 arXiv");
  await expect(run(["new", "paper", "2002.02126", "--dry-run"])).rejects.toThrow("用法");
  expect(await readdir(vault)).toEqual([]);
});

test("removed --yes is an unknown argument, rejected before any requests", async () => {
  let calls = 0;
  await expect(run(["new", "paper", "2002.02126", "--yes"], {
    fetcher: async () => { calls++; throw new Error("must not fetch"); },
  })).rejects.toMatchObject({ code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" });
  expect(calls).toBe(0);
  expect(await readdir(vault)).toEqual([]);
});

test.each([1, 2])("a different paper with %i occupied citekeys uses the next suffix", async (occupied) => {
  await mkdir(join(vault, "library/papers"), { recursive: true });
  const source = await readFile(new URL("../../../fixtures/sync-vault/library/papers/He_2020_LightGCN.md", import.meta.url), "utf8");
  const existing: { path: string; bytes: Buffer; mtime: number; ino: number }[] = [];
  for (const suffix of ["", "b"].slice(0, occupied)) {
    const path = join(vault, `library/papers/He_2020_LightGCN${suffix}.md`);
    const bytes = parseFrontmatter(source.replace("citekey: He_2020_LightGCN", `citekey: He_2020_LightGCN${suffix}`)).render({ doi: `10.1234/occupied${suffix}` });
    await writeFile(path, bytes);
    const info = await stat(path);
    existing.push({ path, bytes, mtime: info.mtimeMs, ino: info.ino });
  }
  const suffix = occupied === 1 ? "b" : "c";
  const citekey = `He_2020_LightGCN${suffix}`;
  expect(await run(["new", "paper", "2002.02126"])).toEqual({ code: 0, output: [`library/papers/${citekey}.md`] });
  const parsed = parseFrontmatter(await readFile(join(vault, `library/papers/${citekey}.md`)));
  expect(Paper.safeParse(parsed.data).success).toBe(true);
  expect(parsed.data.citekey).toBe(citekey);
  expect(parsed.body.toString()).toContain(`@misc{${citekey},`);
  const newPath = join(vault, `library/papers/${citekey}.md`);
  const newBytes = await readFile(newPath);
  const newInfo = await stat(newPath);
  expect((await run(["sync"])).output).toEqual([`完成：扫描 ${occupied + 1} 个，补全 0 个，问题 0 个，跳过 0 个`]);
  expect(await readFile(newPath)).toEqual(newBytes);
  expect((await stat(newPath)).mtimeMs).toBe(newInfo.mtimeMs);
  expect((await stat(newPath)).ino).toBe(newInfo.ino);
  for (const file of existing) {
    expect((await readFile(file.path)).equals(file.bytes)).toBe(true);
    expect((await stat(file.path)).mtimeMs).toBe(file.mtime);
    expect((await stat(file.path)).ino).toBe(file.ino);
  }
  expect(await readdir(join(vault, "library/papers"))).toHaveLength(occupied + 1);
});
