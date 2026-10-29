import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CheckResult, LinksResult } from "@lumio/schema";
import { buildBib, checkLinks, collectCitations, noteLinks, searchNotes } from "../src/index.ts";
import { extractCitations, extractLinks, plainText, resolveMarkdownPath } from "../src/index/links.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/query-vault", import.meta.url));
const markdown = fileURLToPath(new URL("./fixtures/markdown-links", import.meta.url));
const cliMain = fileURLToPath(new URL("../../../apps/cli/src/main.ts", import.meta.url));
const fromPath = "research/ideas/nested/Markdown.md";
const paperPath = "library/papers/Alpha_2024_Paper.md";
let temp: string, vault: string, stateDir: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-markdown-links-"));
  vault = join(temp, "vault"); stateDir = join(temp, "state");
  await cp(fixture, vault, { recursive: true });
  await cp(markdown, vault, { recursive: true });
  for (const name of ["Target space", "Bad%ZZ", "Target_(draft)", "Hash#name"]) {
    await cp(join(fixture, "research/ideas/NoID.md"), join(vault, `research/ideas/${name}.md`));
  }
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

test("extracts inline note destinations, decodes URLs and preserves origin paths, ignoring other Markdown constructs", async () => {
  const links = extractLinks({}, await readFile(join(vault, fromPath), "utf8"), fromPath);
  expect(links.filter((l) => l.source === "wikilink").map((l) => l.target)).toEqual(["Alpha_2024_Paper", "Twin"]);
  expect(links.filter((l) => l.source === "markdown").map((l) => [l.target, l.fromPath])).toEqual([
    "../NoID.md", "../../../library/papers/Alpha_2024_Paper.md", "/library/papers/Alpha_2024_Paper.md",
    "./.././NoID.md", "../Target space.md", "../Target space.md",
    "../../../library/papers/Alpha_2024_Paper.md", "../../../library/papers/Alpha_2024_Paper.md",
    "../NoID", "/library/papers/Alpha_2024_Paper", "../../../library/sources/来源笔记.md", "../a/Twin.md",
    "../Bad%ZZ.md", "../Target_(draft).md", "../Target_(draft).md", "../Hash#name.md", "../NoID.md",
    "../Missing.md", "../../../../library/papers/Alpha_2024_Paper.md", "../../../library/papers/alpha_2024_Paper.md",
    "Alpha_2024_Paper.md", "../../../life/assets/Private.md",
  ].map((target) => [target, fromPath]));
});

test("handles titles, escapes, malformed syntax, URL suffixes, code and unfinished blocks", () => {
  const targets = (body: string) => extractLinks({}, body, fromPath).map((l) => l.target);
  expect(targets('[x](<../a b.md> "title with ) and [brackets]") [x](../b.md (title)) [x](../c%20d.md?q=x#h)')).toEqual(["../a b.md", "../b.md", "../c d.md"]);
  expect(targets("[x](../encoded%2Emd) [x](../a%3Fb.md) [x](../bad%ZZ.md#h)")).toEqual(["../encoded.md", "../a?b.md", "../bad%ZZ.md"]);
  for (const body of ["[x](../a b.md)", "[x](<../a.md)", '[x](../a.md "unclosed)', "[x](../a(b.md)", "[x]()", "[x](../folder/)", "[x](HTTPS:outside.md)", "[x](data:text.md)", "[x](../a.pdf?x#h)"]) {
    expect(targets(body)).toEqual([]);
  }
  expect(targets("[x](../real.md)\n```md\n[x](../fake.md)")).toEqual(["../real.md"]);
  expect(targets("[x](../real.md)\n<!-- lumio:ai start name=x -->\n[x](../fake.md)")).toEqual(["../real.md"]);
  expect(extractCitations("`[x](a.md)`\n<!-- lumio:ai start name=x -->\n[x](b.md) ![x](c.md) \\cite{a,b}", fromPath)).toEqual({ citations: [], ignored: 2 });
  expect(plainText("[visible label](../note.md) and [[Note|alias]]")).toBe("visible label and alias");
});

test("normalizes vault-relative paths without clamping escapes or decoding encoded filename characters twice", () => {
  expect(resolveMarkdownPath(fromPath, "../NoID")).toBe("research/ideas/NoID.md");
  expect(resolveMarkdownPath(fromPath, "/library/./papers/../papers/Alpha_2024_Paper.md")).toBe(paperPath);
  expect(resolveMarkdownPath(fromPath, "../../../../library/papers/Alpha_2024_Paper.md")).toBeUndefined();
  expect(resolveMarkdownPath(fromPath, "/../library/papers/Alpha_2024_Paper.md")).toBeUndefined();
  expect(resolveMarkdownPath(fromPath, "../Hash#name.md")).toBe("research/ideas/Hash#name.md");
});

test("indexes exact paths, retains both sources, exposes backlinks and dangling links with schema validation", async () => {
  const result = LinksResult.parse(await noteLinks(vault, "Markdown", { stateDir }));
  const human = result.outgoing.filter((l) => l.target !== "Twin" && l.target !== "../../../life/assets/Private.md");
  expect(human.filter((l) => !l.dangling)).toHaveLength(18);
  expect(human.filter((l) => l.dangling).map((l) => l.target)).toEqual([
    "../Missing.md", "../../../../library/papers/Alpha_2024_Paper.md", "../../../library/papers/alpha_2024_Paper.md", "Alpha_2024_Paper.md",
  ]);
  expect(result.outgoing.filter((l) => l.note?.path === paperPath).map((l) => l.source)).toEqual(["wikilink", ...Array(5).fill("markdown")]);
  expect(result.outgoing.find((l) => l.target === "../a/Twin.md")?.note?.path).toBe("research/ideas/a/Twin.md");
  expect(result.outgoing.find((l) => l.target === "Twin")?.dangling).toBe(true);
  const incoming = LinksResult.parse(await noteLinks(vault, "Alpha_2024_Paper", { stateDir })).incoming.filter((l) => l.note.path === fromPath);
  expect(incoming.map((l) => l.source)).toEqual(["wikilink", ...Array(5).fill("markdown")]);
  const broken = CheckResult.parse(await checkLinks(vault, { stateDir })).dangling.filter((l) => l.from.path === fromPath);
  expect(broken.filter((l) => l.source === "markdown").map((l) => l.target).sort()).toEqual(human.filter((l) => l.dangling).map((l) => l.target).sort());
  expect((await searchNotes(vault, "relative", { stateDir })).hits.find((h) => h.note.path === fromPath)?.snippet).not.toContain("](");
});

test("refreshes existing Markdown edges when targets are added, renamed, restored and removed", async () => {
  const missing = join(vault, "research/ideas/Missing.md"), renamed = join(vault, "research/ideas/Renamed.md");
  const edge = async () => (await noteLinks(vault, "Markdown", { stateDir })).outgoing.find((l) => l.target === "../Missing.md")!;
  expect((await edge()).dangling).toBe(true);
  await cp(join(fixture, "research/ideas/NoID.md"), missing);
  expect((await edge()).note?.path).toBe("research/ideas/Missing.md");
  expect((await noteLinks(vault, "Missing", { stateDir })).incoming[0]?.note.path).toBe(fromPath);
  await rename(missing, renamed); expect((await edge()).dangling).toBe(true);
  await rename(renamed, missing); expect((await edge()).dangling).toBe(false);
  await unlink(missing); expect((await edge()).dangling).toBe(true);
});

test("rebuilds version 2 indexes so unchanged notes gain Markdown links on the first query", async () => {
  await noteLinks(vault, "Markdown", { stateDir });
  const db = new Database(join(stateDir, "index.sqlite"));
  db.exec("DELETE FROM links WHERE source='markdown'; UPDATE metadata SET version=2");
  db.close();
  expect((await noteLinks(vault, "Markdown", { stateDir })).outgoing.some((l) => l.source === "markdown" && l.note?.path === paperPath)).toBe(true);
  const rebuilt = new Database(join(stateDir, "index.sqlite"));
  try { expect(rebuilt.query("SELECT version FROM metadata").get()).toEqual({ version: 3 }); }
  finally { rebuilt.close(); }
});

test("collects Markdown paper citations, deduplicates sources and warns about ignored AI citations", async () => {
  const result = await collectCitations(vault, "Markdown", { stateDir });
  expect(result.papers.map((p) => p.path)).toEqual([paperPath]);
  expect(result.warnings).toEqual(["AI 区块中有 3 处引用未计入"]);
  const bib = await buildBib(vault, result.papers);
  expect(bib.count).toBe(1); expect(bib.content).toContain("@article{Alpha_2024_Paper,");
  expect(bib.content).not.toContain("Zeta_2025_Study");
});

test("private target details, private backlinks and private dangling links stay hidden by default", async () => {
  const privatePath = "life/assets/Private.md";
  await writeFile(join(vault, privatePath), (await readFile(join(vault, privatePath), "utf8")) + `\n[back](/${fromPath}) [missing](PrivateMissing.md)\n`);
  const publicLinks = await noteLinks(vault, "Markdown", { stateDir });
  expect(publicLinks.outgoing.find((l) => l.target === "../../../life/assets/Private.md")).toEqual({
    source: "markdown", target: "../../../life/assets/Private.md", dangling: true,
  });
  expect(publicLinks.outgoing.some((l) => l.note?.path === privatePath)).toBe(false);
  expect(publicLinks.incoming.some((l) => l.note.path === privatePath)).toBe(false);
  const included = await noteLinks(vault, "Markdown", { stateDir, includePrivate: true });
  expect(included.outgoing.find((l) => l.target === "../../../life/assets/Private.md")?.note?.path).toBe(privatePath);
  expect(included.incoming.some((l) => l.note.path === privatePath)).toBe(true);
  expect((await checkLinks(vault, { stateDir })).dangling.some((l) => l.target.includes("Private"))).toBe(false);
  expect((await checkLinks(vault, { stateDir, includePrivate: true })).dangling.some((l) => l.target === "PrivateMissing.md")).toBe(true);
});

test("a dangling Markdown path is not hidden merely because a private note has the same basename", async () => {
  await writeFile(join(vault, fromPath), (await readFile(join(vault, fromPath), "utf8")) + "\n[public missing path](Private)\n");
  const result = await checkLinks(vault, { stateDir });
  expect(result.dangling.find((l) => l.from.path === fromPath && l.target === "Private")).toMatchObject({ source: "markdown" });
  expect((await noteLinks(vault, "Markdown", { stateDir, includePrivate: true })).outgoing.find((l) => l.target === "Private")?.dangling).toBe(true);
});

test("CLI links/check JSON accept source markdown and export bib --from follows only resolved public paper paths", async () => {
  const home = join(temp, "home"); await mkdir(home);
  const cli = (args: string[]) => Bun.spawnSync([process.execPath, cliMain, ...args], {
    env: { ...process.env, HOME: home, LUMIO_VAULT: vault, LUMIO_STATE_DIR: stateDir, LUMIO_HUB_URL: undefined, LUMIO_TOKEN: undefined },
    stdout: "pipe", stderr: "pipe",
  });
  const links = cli(["links", "Markdown", "--json"]);
  expect(links.exitCode).toBe(0); expect(links.stderr.toString()).toBe("");
  expect(LinksResult.parse(JSON.parse(links.stdout.toString())).outgoing.some((l) => l.source === "markdown" && l.note?.path === paperPath)).toBe(true);
  const check = cli(["check", "--json"]);
  expect(check.exitCode).toBe(0); expect(check.stderr.toString()).toBe("");
  expect(CheckResult.parse(JSON.parse(check.stdout.toString())).dangling.some((l) => l.source === "markdown" && l.target === "../Missing.md")).toBe(true);
  // Remove the wikilink to ensure this export can only reach the paper via Markdown.
  await writeFile(join(vault, fromPath), (await readFile(join(vault, fromPath), "utf8")).replace("[[Alpha_2024_Paper]]", ""));
  const bib = cli(["export", "bib", "--from", "Markdown"]);
  expect(bib.exitCode).toBe(0); expect(bib.stdout.toString()).toContain("@article{Alpha_2024_Paper,");
  expect(bib.stdout.toString()).not.toContain("Zeta_2025_Study");
  expect(bib.stderr.toString()).toContain("AI 区块中有 3 处引用未计入");
  expect(await Bun.file(join(vault, "library/refs.bib")).exists()).toBe(false);
});
