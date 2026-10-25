import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CheckResult, LinksResult, NoteDetail, SearchResult } from "@lumio/schema";

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
    env: { ...process.env, LUMIO_VAULT: vault, LUMIO_STATE_DIR: state, LUMIO_HUB_URL: undefined, LUMIO_TOKEN: undefined },
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

test("export --from prints only selected BibTeX to stdout, warnings to stderr, and only writes with --out", async () => {
  const citations = fileURLToPath(new URL("../../../fixtures/citations", import.meta.url));
  await cp(join(citations, "Report.md"), join(vault, "research/ideas/Report.md"));
  await cp(join(citations, "Gamma_2026_Uncited.md"), join(vault, "library/papers/Gamma_2026_Uncited.md"));
  const result = cli(["export", "bib", "--from", "Report"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("% 本文件由 lumio 生成，请勿手动编辑\n\n@article{Alpha_2024_Paper,");
  expect(result.stdout.match(/@article\{/g)).toHaveLength(2);
  expect(result.stdout.indexOf("Alpha_2024_Paper")).toBeLessThan(result.stdout.indexOf("Zeta_2025_Study"));
  for (const absent of ["Gamma_2026_Uncited", "导出", "未计入", "找不到", "缺少"]) expect(result.stdout).not.toContain(absent);
  for (const warning of ["AI 区块中有 3 处引用未计入", "找不到 citekey：Missing_2026_Paper", "缺少 BibTeX", "key 已纠正"]) expect(result.stderr).toContain(warning);
  expect(await Bun.file(join(vault, "library/refs.bib")).exists()).toBe(false);
  const out = join(temp, "custom", "selected.bib");
  expect(cli(["export", "bib", "--from", "idea_00000000000000000000000030", "--out", out]).code).toBe(0);
  expect(await readFile(out, "utf8")).toBe(result.stdout);
  const before = await stat(out);
  const repeated = cli(["export", "bib", "--from", "Report", "--out", out]);
  expect(repeated.code).toBe(0); expect(repeated.stdout).toContain("未变化"); expect((await stat(out)).mtimeMs).toBe(before.mtimeMs);
  const privateSource = cli(["export", "bib", "--from", "Private"]);
  expect(privateSource.code).toBe(1); expect(privateSource.stdout).toBe(""); expect(privateSource.stderr).toContain("找不到笔记");
  for (const args of [["check", "unexpected"], ["check", "--out", out], ["check", "--limit", "1"], ["search", "x", "--from", "Report"], ["export", "bib", "--from", ""], ["sync", "--from", "Report"]]) {
    expect(cli(args).code).toBe(1);
  }
});

test("check reports sorted paths and count, includes related, and returns zero even for dangling links", () => {
  const result = CheckResult.parse(json(["check"]));
  expect(result.total).toBeGreaterThan(0);
  const human = cli(["check"]); expect(human.code).toBe(0); expect(human.stderr).toBe("");
  expect(human.stdout).toBe(result.dangling.map((l) => `${l.from.path}  →  [[${l.target}]]\n`).join("") + `共 ${result.total} 条悬空链接\n`);
  expect(result.dangling.some((l) => l.source === "related")).toBe(true);
  expect(result.dangling.some((l) => l.target === "Private" || l.target.startsWith("ast_"))).toBe(false);
  CheckResult.parse(json(["check", "--include-private"]));
});

test("check lists all old wikilinks after rename and reports no dangling links after restoration", async () => {
  const root = join(temp, "clean");
  await mkdir(join(root, "library/papers"), { recursive: true }); await mkdir(join(root, "research/ideas"), { recursive: true });
  await mkdir(join(root, "life/assets"), { recursive: true });
  for (const path of ["library/papers/Alpha_2024_Paper.md", "life/assets/Private.md"]) await cp(join(fixture, path), join(root, path));
  const check = fileURLToPath(new URL("../../../fixtures/citations/Check.md", import.meta.url));
  await cp(check, join(root, "research/ideas/Main.md"));
  const args = ["check", "--vault", root];
  expect(cli(args).stdout).toBe("没有悬空链接\n");
  const old = join(root, "library/papers/Alpha_2024_Paper.md"), renamed = join(root, "library/papers/Renamed.md");
  await rename(old, renamed);
  const broken = cli(args); expect(broken.code).toBe(0); expect(broken.stdout).toContain("共 3 条悬空链接");
  expect(broken.stdout).not.toContain("Private");
  await rename(renamed, old); expect(cli(args).stdout).toBe("没有悬空链接\n");
});
