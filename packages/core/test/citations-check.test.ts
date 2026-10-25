import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CheckResult, NoteRef } from "@lumio/schema";
import { buildBib, checkLinks, collectCitations, entityDirectory, exportBib } from "../src/index.ts";
import { extractCitations } from "../src/index/links.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/query-vault", import.meta.url));
const citations = fileURLToPath(new URL("../../../fixtures/citations", import.meta.url));
let temp: string, vault: string, stateDir: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-citations-")); vault = join(temp, "vault"); stateDir = join(temp, "state");
  await cp(fixture, vault, { recursive: true });
  await cp(join(citations, "Report.md"), join(vault, entityDirectory("idea"), "Report.md"));
  await cp(join(citations, "Gamma_2026_Uncited.md"), join(vault, entityDirectory("paper"), "Gamma_2026_Uncited.md"));
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

test("collects public paper citations by filename and LaTeX key, deduplicates, and ignores code/AI/nonpapers/related", async () => {
  const result = await collectCitations(vault, "Report", { stateDir });
  expect(result.papers.map((p) => NoteRef.parse(p).citekey).sort()).toEqual(["Alpha_2024_Paper", "NoBib_2026_Paper", "Zeta_2025_Study"]);
  expect(result.warnings).toEqual(["AI 区块中有 3 处引用未计入", "找不到 citekey：Missing_2026_Paper"]);
  const bib = await buildBib(vault, result.papers);
  expect(bib.count).toBe(2);
  expect(bib.content.indexOf("@article{Alpha_")).toBeLessThan(bib.content.indexOf("@article{Zeta_"));
  expect(bib.content.match(/@article\{/g)).toHaveLength(2);
  expect(bib.content).not.toContain("Gamma_"); expect(bib.content).not.toContain("wrong_key");
  expect(bib.warnings).toContain("缺少 BibTeX 一节或代码块，跳过：library/papers/NoBib_2026_Paper.md");
  const out = join(temp, "export.bib");
  expect((await exportBib(vault, out, result.papers)).changed).toBe(true);
  const before = await stat(out);
  expect((await exportBib(vault, out, result.papers)).changed).toBe(false);
  expect((await stat(out)).mtimeMs).toBe(before.mtimeMs); expect(await readFile(out, "utf8")).toBe(bib.content);
  expect((await buildBib(vault, [])).count).toBe(0);
});

test("source references share show resolution and privacy; paper filenames and citekeys resolve independently", async () => {
  for (const ref of ["Report", "idea_00000000000000000000000030"]) expect((await collectCitations(vault, ref, { stateDir })).papers).toHaveLength(3);
  for (const ref of ["Alpha_2024_Paper", "pap_00000000000000000000000001"]) expect((await collectCitations(vault, ref, { stateDir })).papers).toHaveLength(0);
  for (const ref of ["Private", "ast_00000000000000000000000007", "Card", "missing"]) {
    await expect(collectCitations(vault, ref, { stateDir })).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  }
  try { await collectCitations(vault, "Twin", { stateDir }); throw new Error("Expected ambiguity"); }
  catch (cause) {
    expect(cause).toMatchObject({ code: "AMBIGUOUS_REFERENCE" });
    expect(String(cause)).toContain("library/sources/b/Twin.md"); expect(String(cause)).toContain("research/ideas/a/Twin.md");
  }
  await rename(join(vault, entityDirectory("paper"), "Alpha_2024_Paper.md"), join(vault, entityDirectory("paper"), "Renamed.md"));
  await writeFile(join(vault, entityDirectory("idea"), "Report.md"), "[[Renamed]] \\cite{Alpha_2024_Paper} \\cite{Renamed}");
  const result = await collectCitations(vault, "Report", { stateDir });
  expect(result.papers.map((p) => p.citekey)).toEqual(["Alpha_2024_Paper"]);
  expect(result.warnings).toEqual(["找不到 citekey：Renamed"]);
});

test("all five LaTeX commands, multiple optional arguments, inline and unfinished fences/AI blocks", () => {
  const parsed = extractCitations(String.raw`\cite{ a,b } \citep[第3页]{c} \citet[x][y]{d} \parencite{e} \textcite{f}`);
  expect(parsed.citations.map((c) => c.target)).toEqual(["a", "b", "c", "d", "e", "f"]);
  expect(extractCitations("\\cite{a}\n<!-- lumio:ai start name=x -->\n[[b]] \\cite{c,d}")).toEqual({ citations: [{ source: "cite", target: "a" }], ignored: 2 });
  expect(extractCitations("\\cite{a}\n```tex\n\\cite{b}").citations.map((c) => c.target)).toEqual(["a"]);
});

test("renames list every broken wikilink, restore empties the list, and private targets never appear", async () => {
  const root = join(temp, "clean-vault");
  for (const type of ["paper", "idea", "asset"] as const) await mkdir(join(root, entityDirectory(type)), { recursive: true });
  for (const path of ["library/papers/Alpha_2024_Paper.md", "life/assets/Private.md"]) await cp(join(fixture, path), join(root, path));
  await cp(join(citations, "Check.md"), join(root, entityDirectory("idea"), "Check.md"));
  // The fixture's private backlink targets Main; supply that source from a fixture as well.
  await cp(join(citations, "Check.md"), join(root, entityDirectory("idea"), "Main.md"));
  for (const includePrivate of [false, true]) expect(CheckResult.parse(await checkLinks(root, { stateDir, includePrivate }))).toEqual({ dangling: [], total: 0 });
  const oldPath = join(root, entityDirectory("paper"), "Alpha_2024_Paper.md"), newPath = join(root, entityDirectory("paper"), "Renamed.md");
  await rename(oldPath, newPath);
  const broken = CheckResult.parse(await checkLinks(root, { stateDir }));
  expect(broken.total).toBe(6); expect(broken.dangling.every((l) => l.target === "Alpha_2024_Paper" && l.source === "wikilink")).toBe(true);
  expect(broken.dangling.map((l) => l.from.path)).toEqual([...Array(3).fill("research/ideas/Check.md"), ...Array(3).fill("research/ideas/Main.md")]);
  await rename(newPath, oldPath); expect((await checkLinks(root, { stateDir })).total).toBe(0);
  await writeFile(join(root, entityDirectory("asset"), "Private.md"), (await readFile(join(fixture, "life/assets/Private.md"), "utf8")) + "\n[[PrivateMissing]]\n");
  expect((await checkLinks(root, { stateDir })).total).toBe(0);
  expect((await checkLinks(root, { stateDir, includePrivate: true })).dangling.map((l) => l.target)).toEqual(["PrivateMissing"]);
});

test("check includes old related IDs, sorts by source path and target, and hides ambiguous private targets", async () => {
  const result = CheckResult.parse(await checkLinks(vault, { stateDir }));
  expect(result.dangling.some((l) => l.source === "related" && l.target === "idea_00000000000000000000000099")).toBe(true);
  expect(result.dangling.some((l) => l.target === "Private" || l.target === "ast_00000000000000000000000007")).toBe(false);
  const keys = result.dangling.map((l) => `${l.from.path}\t${l.target}`);
  expect(keys).toEqual([...keys].sort());
  await cp(join(fixture, "life/assets/Private.md"), join(vault, "life/assets/Twin.md"));
  expect((await checkLinks(vault, { stateDir })).dangling.some((l) => l.target === "Twin")).toBe(false);
});
