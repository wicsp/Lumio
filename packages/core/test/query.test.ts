import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LinksResult, NoteDetail, SearchResult } from "@lumio/schema";
import { CoreError, excludedCardPaths, exportBib, noteLinks, parseFrontmatter, searchNotes, showNote } from "../src/index.ts";
import { extractLinks } from "../src/index/links.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/query-vault", import.meta.url));
let temp: string, vault: string, stateDir: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-query-"));
  vault = join(temp, "vault"); stateDir = join(temp, "state");
  await cp(fixture, vault, { recursive: true });
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
const alpha = "pap_00000000000000000000000001";

test("trigram and short searches cover all fields, Unicode, case, and literal metacharacters", async () => {
  for (const query of ["来源", "中文测试", "index", "INDEX", "Ada Author", "Source Author", "Alpha_2024", "citationtag", "x%", "y_", '"text"', "😀😀😀"]) {
    const result = SearchResult.parse(await searchNotes(vault, query, { stateDir }));
    expect(result.total).toBeGreaterThan(0);
    for (const hit of result.hits) expect(Array.from(hit.snippet).length).toBeLessThanOrEqual(200);
  }
  expect((await searchNotes(vault, "index", { stateDir, type: "paper", limit: 1 })).hits).toHaveLength(1);
  const all = await searchNotes(vault, "index", { stateDir, limit: 1 });
  expect(all.total).toBeGreaterThan(all.hits.length);
  expect((await searchNotes(vault, "%", { stateDir })).total).toBe(1);
  expect((await searchNotes(vault, "\\", { stateDir })).total).toBe(0);
  await expect(searchNotes(vault, " ", { stateDir })).rejects.toMatchObject({ code: "INVALID_QUERY" });
  await expect(searchNotes(vault, "a", { stateDir, limit: 0 })).rejects.toMatchObject({ code: "INVALID_LIMIT" });
});

test("references resolve real IDs, citekeys, filenames, and report ambiguous candidates", async () => {
  for (const reference of [alpha, "Alpha_2024_Paper"]) {
    expect(NoteDetail.parse(await showNote(vault, reference, { stateDir })).note.id).toBe(alpha);
  }
  // A different filename demonstrates citekey lookup independently.
  await rename(join(vault, "library/papers/Alpha_2024_Paper.md"), join(vault, "library/papers/Renamed.md"));
  for (const reference of [alpha, "Alpha_2024_Paper", "Renamed"]) {
    expect((await showNote(vault, reference, { stateDir })).note.id).toBe(alpha);
  }
  try { await showNote(vault, "Twin", { stateDir }); throw new Error("expected ambiguity"); }
  catch (cause) {
    expect(cause).toBeInstanceOf(CoreError);
    expect(cause).toMatchObject({ code: "AMBIGUOUS_REFERENCE" });
    expect((cause as Error).message).toContain("research/ideas/a/Twin.md");
    expect((cause as Error).message).toContain("library/sources/b/Twin.md");
  }
  await expect(showNote(vault, "absent", { stateDir })).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
});

test("ID-less notes are indexed with stable result-only IDs, and never written back", async () => {
  const path = join(vault, "research/ideas/NoID.md");
  const original = await readFile(path);
  const detail = NoteDetail.parse(await showNote(vault, "NoID", { stateDir }));
  expect(detail.note.id).toMatch(/^idea_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(detail.frontmatter.id).toBeUndefined();
  expect((await searchNotes(vault, "无标识", { stateDir })).hits[0]!.note.id).toBe(detail.note.id);
  expect(LinksResult.parse(await noteLinks(vault, "NoID", { stateDir })).note.id).toBe(detail.note.id);
  expect((await showNote(vault, "NoID", { stateDir })).note.id).toBe(detail.note.id);
  await expect(showNote(vault, detail.note.id, { stateDir })).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  expect(await readFile(path)).toEqual(original);
  await rename(path, join(vault, "research/ideas/NewName.md"));
  expect((await showNote(vault, "NewName", { stateDir })).note.id).not.toBe(detail.note.id);
});

test("links resolve outgoing, backlinks, related IDs and dangling targets; code and AI links are ignored", async () => {
  const result = LinksResult.parse(await noteLinks(vault, "Main", { stateDir }));
  expect(result.outgoing.filter((l) => l.note?.id === alpha)).toHaveLength(5);
  expect(result.outgoing.filter((l) => l.dangling).map((l) => l.target)).toEqual([
    "ast_00000000000000000000000007", "idea_00000000000000000000000099", "Ghost", "Twin", "Private", "AfterFence", "AfterAI",
  ]);
  expect(result.outgoing.find((l) => l.target === "NoID")?.dangling).toBe(false);
  expect(result.incoming.map((l) => l.note.title).sort()).toEqual(["No ID note", "来源教程"].sort());
  const serialized = JSON.stringify(result);
  for (const absent of ["InlineFake", "DoubleFake", "FenceFake", "AIFake"]) expect(serialized).not.toContain(absent);
  const backlinks = await noteLinks(vault, alpha, { stateDir });
  expect(backlinks.incoming).toHaveLength(5);
  expect(backlinks.incoming.every((l) => l.note.title === "Main graph")).toBe(true);
});

test("fences, inline runs, and unfinished AI/code blocks never create human links", () => {
  expect(extractLinks({}, "~~~~md\n[[fake]]\n~~~~~\n[[real]]\n``[[fake2]] ` literal``\n[[real2]]").map((l) => l.target)).toEqual(["real", "real2"]);
  expect(extractLinks({}, "[[real]]\n```md\n[[fake]]").map((l) => l.target)).toEqual(["real"]);
  expect(extractLinks({}, "[[real]]\n<!-- lumio:ai start name=x -->\n[[fake]]").map((l) => l.target)).toEqual(["real"]);
});

test("private notes and backlinks are hidden by default; inclusion restores them", async () => {
  expect((await searchNotes(vault, "privateonly", { stateDir })).total).toBe(0);
  for (const reference of ["Private", "ast_00000000000000000000000007"]) {
    await expect(showNote(vault, reference, { stateDir })).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
    await expect(noteLinks(vault, reference, { stateDir })).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  }
  const options = { stateDir, includePrivate: true };
  expect((await searchNotes(vault, "privateonly", options)).total).toBe(1);
  expect(NoteDetail.parse(await showNote(vault, "Private", options)).note.type).toBe("asset");
  expect(LinksResult.parse(await noteLinks(vault, "Private", options)).incoming).toHaveLength(2);
  const main = await noteLinks(vault, "Main", options);
  expect(main.outgoing.filter((l) => l.note?.type === "asset")).toHaveLength(2);
  expect(main.incoming.some((l) => l.note.type === "asset")).toBe(true);
});

test("card text is never indexed or exposed, even with private inclusion", async () => {
  expect((await searchNotes(vault, "cardonlymarker", { stateDir, includePrivate: true })).total).toBe(0);
  expect((await searchNotes(vault, "4111", { stateDir })).total).toBe(0);
  await expect(showNote(vault, "Card", { stateDir })).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  expect(await excludedCardPaths(vault, { stateDir })).toEqual(["research/ideas/Card.md"]);
  const db = new Database(join(stateDir, "index.sqlite"));
  expect(JSON.stringify(db.query("SELECT * FROM notes").all())).not.toContain("4111");
  expect(JSON.stringify(db.query("SELECT * FROM fulltext").all())).not.toContain("4111");
  db.close();
});

test("incremental queries parse only changed files, remove deleted notes and refresh link resolution", async () => {
  let parsed = 0;
  const options = { stateDir, parse: ((source) => { parsed++; return parseFrontmatter(source); }) as typeof parseFrontmatter };
  await searchNotes(vault, "index", options);
  expect(parsed).toBe(14);
  await noteLinks(vault, "Main", options);
  expect(parsed).toBe(14);
  const sourcePath = join(vault, "library/sources/来源笔记.md");
  await writeFile(sourcePath, (await readFile(sourcePath, "utf8")) + "\nnewincrementalmarker\n");
  expect((await searchNotes(vault, "newincrementalmarker", options)).total).toBe(1);
  expect(parsed).toBe(15);
  await unlink(sourcePath);
  expect((await searchNotes(vault, "newincrementalmarker", options)).total).toBe(0);
  expect((await noteLinks(vault, "Main", options)).outgoing.find((l) => l.target === "来源笔记")?.dangling).toBe(true);
  expect(parsed).toBe(15);
  const mainPath = join(vault, "research/ideas/Main.md");
  await writeFile(mainPath, (await readFile(mainPath, "utf8")) + "\n4111 1111 1111 1111\n");
  await expect(showNote(vault, "Main", options)).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  expect((await noteLinks(vault, alpha, options)).incoming).toHaveLength(0);
});

test("short queries sort by modification time and long snippets stay plain and bounded", async () => {
  const main = join(vault, "research/ideas/Main.md");
  await writeFile(main, (await readFile(main, "utf8")) + `\n${"前".repeat(250)} **定位** [来源](https://example.invalid) ${"后".repeat(250)}\n`);
  const short = await searchNotes(vault, "来源", { stateDir });
  expect(short.hits[0]!.note.path).toBe("research/ideas/Main.md");
  const hit = (await searchNotes(vault, "定位", { stateDir })).hits[0]!;
  expect(hit.snippet).toContain("定位 来源");
  expect(hit.snippet).not.toContain("**");
  expect(Array.from(hit.snippet).length).toBe(200);
  const literal = "**formatmarker**";
  await writeFile(main, (await readFile(main, "utf8")) + `\n${"前".repeat(250)} ${literal} ${"后".repeat(250)}\n`);
  expect((await searchNotes(vault, literal, { stateDir })).hits[0]!.snippet).toContain("formatmarker");
});

test("damaged, incompatible and other-vault indexes rebuild safely", async () => {
  await searchNotes(vault, "index", { stateDir });
  const index = join(stateDir, "index.sqlite");
  await writeFile(index, "not a SQLite database");
  expect((await searchNotes(vault, "index", { stateDir })).total).toBe(3);
  const db = new Database(index);
  db.exec("UPDATE metadata SET version=999"); db.close();
  expect((await searchNotes(vault, "index", { stateDir })).total).toBe(3);
  const second = join(temp, "another-vault");
  await cp(fixture, second, { recursive: true });
  await unlink(join(second, "research/ideas/Main.md"));
  expect((await searchNotes(second, "index", { stateDir })).total).toBe(2);
});

test("BibTeX export is sorted, corrects keys, warns on missing blocks, excludes sensitive/private data and avoids rewrites", async () => {
  const first = await exportBib(vault);
  expect(first.count).toBe(2);
  expect(first.changed).toBe(true);
  expect(first.warnings).toEqual([
    "缺少 BibTeX 一节或代码块，跳过：library/papers/NoBib_2026_Paper.md",
    "BibTeX key 已纠正：library/papers/Zeta_2025_Study.md",
  ]);
  const content = await readFile(first.path, "utf8");
  expect(content).toBe("% 本文件由 lumio 生成，请勿手动编辑\n\n@article{Alpha_2024_Paper,\n  title = {English Index Paper}\n}\n\n@article{Zeta_2025_Study,\n  title = {中文索引论文}\n}\n");
  const before = await stat(first.path);
  expect((await exportBib(vault)).changed).toBe(false);
  const after = await stat(first.path);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.ino).toBe(before.ino);
  const privatePath = join(vault, "life/assets/Private.md");
  await writeFile(privatePath, (await readFile(privatePath, "utf8")) + "\n## BibTeX\n```bibtex\n@article{Private_2026_Paper, title={Private}}\n```\n");
  const paper = join(vault, "library/papers/Alpha_2024_Paper.md");
  await writeFile(paper, (await readFile(paper, "utf8")) + "\n4111 1111 1111 1111\n");
  const exported = await exportBib(vault, join(temp, "custom", "output.bib"));
  expect(exported.count).toBe(1);
  expect((await readFile(exported.path, "utf8"))).not.toContain("Private");
  expect(JSON.stringify(exported)).not.toContain("4111");
});

test("BibTeX extraction respects section boundaries and ignores headings inside example fences", async () => {
  const path = join(vault, "library/papers/NoBib_2026_Paper.md");
  const original = await readFile(path, "utf8");
  await writeFile(path, original + "\n````md\n## BibTeX\n```bibtex\n@article{Fake_2026_Paper, title={Example}}\n```\n````\n\n## Other\n```bibtex\n@article{Outside_2026_Paper, title={Outside section}}\n```\n");
  expect((await exportBib(vault)).count).toBe(2);
  await writeFile(path, original + "\n## BibTeX\n```bibtex\n@article{NoBib_2026_Paper,\n title={This contains a heading}\n% unchanged comment\n}\n```\n");
  expect((await exportBib(vault)).count).toBe(3);
  expect(await readFile(join(vault, "library/refs.bib"), "utf8")).toContain("% unchanged comment");
});
