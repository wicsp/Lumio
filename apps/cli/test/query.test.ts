import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LinksResult, NoteDetail, SearchResult } from "@lumio/schema";

const fixture = fileURLToPath(new URL("../../../fixtures/query-vault", import.meta.url));
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
let temp: string, vault: string, state: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-query-cli-"));
  vault = join(temp, "vault"); state = join(temp, "state");
  await cp(fixture, vault, { recursive: true });
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

function cli(args: string[]) {
  const result = Bun.spawnSync([process.execPath, main, ...args], {
    env: { ...process.env, LUMIO_VAULT: vault, LUMIO_STATE_DIR: state, LUMIO_HUB_URL: "http://127.0.0.1:1" },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function json(args: string[]) {
  const result = cli([...args, "--json"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.split("\n")).toHaveLength(2);
  return JSON.parse(result.stdout);
}

test("every query JSON is one newline-terminated object accepted by the corresponding schema", () => {
  for (const query of ["来源", "中文测试", "INDEX", "cardonlymarker", "无标识"]) {
    SearchResult.parse(json(["search", query]));
  }
  for (const reference of ["Main", "NoID", "Alpha_2024_Paper", "pap_00000000000000000000000001"]) {
    NoteDetail.parse(json(["show", reference]));
    LinksResult.parse(json(["links", reference]));
  }
  const result = SearchResult.parse(json(["search", "index", "--type", "paper", "--limit", "1"]));
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]!.note.type).toBe("paper");
  const noId = SearchResult.parse(json(["search", "无标识"])).hits[0]!.note;
  expect(noId.path).toBe("research/ideas/NoID.md");
  expect("id" in noId).toBe(false);
});

test("human search ends with blocked paths only and never exposes card text", () => {
  const result = cli(["search", "cardonlymarker"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("找到 0 篇笔记\n有 1 个文件因疑似含卡号未被索引\nresearch/ideas/Card.md\n");
  expect(result.stdout + result.stderr).not.toContain("4111");
  expect(SearchResult.parse(json(["search", "cardonlymarker"])).total).toBe(0);
});

test("private notes are invisible by default in all commands and restored only explicitly", () => {
  expect(SearchResult.parse(json(["search", "privateonly"])).total).toBe(0);
  expect(SearchResult.parse(json(["search", "privateonly", "--include-private"])).total).toBe(1);
  for (const command of ["show", "links"]) {
    const hidden = cli([command, "Private", "--json"]);
    expect(hidden.code).toBe(1);
    expect(hidden.stdout).toBe("");
    expect(hidden.stderr).toContain("找不到笔记");
  }
  NoteDetail.parse(json(["show", "Private", "--include-private"]));
  LinksResult.parse(json(["links", "Private", "--include-private"]));
  expect(LinksResult.parse(json(["links", "Main"])).outgoing.filter((l) => l.target === "Private")[0]!.dangling).toBe(true);
  expect(LinksResult.parse(json(["links", "Main", "--include-private"])).outgoing.find((l) => l.target === "Private")!.note!.type).toBe("asset");
});

test("errors go only to stderr, use exit code 1, and ambiguity lists candidate paths", () => {
  for (const args of [
    ["show", "Twin"], ["links", "Twin", "--json"], ["show", "missing"], ["show", "Card"],
    ["search", "x", "--limit", "0"], ["search", "x", "--limit", "1.5"], ["search", "x", "--type", "nonsense"],
    ["search", "x", "--out", "file"], ["show", "Main", "--limit", "1"], ["links", "Main", "--type", "idea"],
    ["export", "bib", "--include-private"], ["export", "bib", "--json"], ["search"],
    ["new", "idea", "unexpected", "--json"], ["sync", "--limit", "1"],
  ]) {
    const result = cli(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr).not.toContain("4111");
  }
  const ambiguous = cli(["show", "Twin"]);
  expect(ambiguous.stderr).toContain("library/sources/b/Twin.md");
  expect(ambiguous.stderr).toContain("research/ideas/a/Twin.md");
});

test("human show and links render details and dangling targets", () => {
  const detail = cli(["show", "Main"]);
  expect(detail.code).toBe(0);
  expect(detail.stdout).toContain("Main graph");
  expect(detail.stdout).toContain("English INDEX");
  const links = cli(["links", "Main"]);
  expect(links.code).toBe(0);
  expect(links.stdout).toContain("出链：");
  expect(links.stdout).toContain("反向链接：");
  expect(links.stdout).toContain("Ghost（悬空）");
  expect(links.stdout).not.toContain("AIFake");
});

test("export uses default/custom paths, warns on stderr, and leaves unchanged output untouched", async () => {
  const first = cli(["export", "bib"]);
  expect(first.code).toBe(0);
  expect(first.stdout).toContain("导出 2 篇论文");
  expect(first.stderr).toContain("key 已纠正");
  expect(first.stderr).toContain("缺少 BibTeX");
  const path = join(vault, "library/refs.bib");
  const before = await stat(path);
  const result = cli(["export", "bib"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("未变化");
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  const custom = join(temp, "custom.bib");
  expect(cli(["export", "bib", "--out", custom]).code).toBe(0);
  expect(await readFile(custom)).toEqual(await readFile(path));
  expect(await readFile(custom, "utf8")).not.toContain("私密");
  // Explicit --vault overrides the environment and state is always temporary.
  expect(cli(["search", "index", "--vault", vault, "--json"]).code).toBe(0);
  expect((await stat(join(state, "index.sqlite"))).isFile()).toBe(true);
});
