import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Paper } from "@lumio/schema";
import response from "../../../fixtures/papers/crossref-lightgcn.json";
import { generateCitekey, createPaper, fillMetadata, parseCrossrefMetadata, parseFrontmatter, renderPaper, type FillContext } from "../src/index.ts";

const metadata = parseCrossrefMetadata(response);
const citekey = generateCitekey(metadata, "LightGCN");
const ctx: FillContext = {
  now: new Date("2026-10-22T23:00:00+08:00"), tz: "Asia/Singapore",
  newId: (prefix) => `${prefix}_01J9Z3K8M2N4P6Q8R0S2T4V6W8`,
};
const bibtex = await readFile(new URL("../../../fixtures/papers/crossref-lightgcn.bib", import.meta.url), "utf8");
let vault: string;
beforeEach(async () => { vault = await mkdtemp(join(tmpdir(), "lumio-paper-test-")); });
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

test("a rendered paper passes its contract, has all sections and no invented links/default fields", async () => {
  const path = await createPaper(vault, metadata, citekey, bibtex, ctx);
  expect(path).toBe("library/papers/He_2020_LightGCN.md");
  const parsed = parseFrontmatter(await readFile(join(vault, path)));
  expect(Paper.safeParse(parsed.data).success).toBe(true);
  expect(parsed.data).toMatchObject({ type: "paper", citekey: "He_2020_LightGCN", title: metadata.title, authors: metadata.authors, year: metadata.year, doi: metadata.doi });
  for (const field of ["status", "tags", "related", "arxiv", "firstAuthorFamily"]) expect(parsed.data).not.toHaveProperty(field);
  const body = parsed.body.toString();
  expect(body.startsWith("\n## One sentence\n")).toBe(true);
  expect(body.match(/^## .+$/gm)).toEqual(["## One sentence", "## My notes", "## Points to cite", "## Relation to my research", "## BibTeX"]);
  expect(body).toContain("```bibtex\n");
  expect(body).toContain("@inproceedings{He_2020_LightGCN,");
  expect(body).not.toContain("[[");
  expect(fillMetadata({ type: "paper", frontmatter: parsed.data, fileName: "He_2020_LightGCN", birthtime: ctx.now, mtime: ctx.now }, ctx))
    .toEqual({ patch: {}, issues: [] });
  expect(await readdir(vault)).toEqual(["library"]);
});

test("arXiv metadata with empty optional fields omits those fields", () => {
  const parsed = parseFrontmatter(renderPaper({ title: "LightGCN", authors: metadata.authors, year: 2020, arxiv: "2002.02126", doi: "", venue: "" }, citekey, bibtex, ctx).content);
  expect(parsed.data).toHaveProperty("arxiv", "2002.02126");
  for (const key of ["doi", "venue", "url"]) expect(parsed.data).not.toHaveProperty(key);
  expect(Paper.safeParse(parsed.data).success).toBe(true);
});

test("identical DOI is rejected, including case/URL variants and nested existing notes", async () => {
  const path = await createPaper(vault, metadata, citekey, bibtex, ctx);
  await mkdir(join(vault, "library/papers/nested"), { recursive: true });
  const original = await readFile(join(vault, path));
  await writeFile(join(vault, "library/papers/nested/existing.md"), parseFrontmatter("body").render({ doi: `https://doi.org/${metadata.doi!.toUpperCase()}` }));
  await rm(join(vault, path));
  await expect(createPaper(vault, metadata, generateCitekey(metadata, "Other"), bibtex, ctx)).rejects.toMatchObject({ code: "DUPLICATE_PAPER" });
  expect(await readdir(join(vault, "library/papers"))).toEqual(["nested"]);
  expect(original.length).toBeGreaterThan(0);
});

test("identical arXiv is rejected regardless of stored version", async () => {
  await mkdir(join(vault, "library/papers"), { recursive: true });
  const existing = join(vault, "library/papers/existing.md");
  await writeFile(existing, parseFrontmatter("body").render({ arxiv: "https://arxiv.org/abs/2002.02126v2" }));
  const before = await stat(existing);
  const paper = { ...metadata, arxiv: "2002.02126" };
  await expect(createPaper(vault, paper, citekey, bibtex, ctx)).rejects.toMatchObject({ code: "DUPLICATE_PAPER" });
  expect((await stat(existing)).mtimeMs).toBe(before.mtimeMs);
  expect(await readdir(join(vault, "library/papers"))).toEqual(["existing.md"]);
});

test("a different paper with the same citekey gets suffix b without changing the existing file", async () => {
  const path = join(vault, await createPaper(vault, metadata, citekey, bibtex, ctx));
  const bytes = await readFile(path);
  const before = await stat(path);
  expect(await createPaper(vault, { ...metadata, doi: "10.1234/different" }, citekey, bibtex, ctx)).toBe("library/papers/He_2020_LightGCNb.md");
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect((await stat(path)).ino).toBe(before.ino);
});

test("invalid citekey, metadata and BibTeX fail before filesystem changes", async () => {
  await expect(createPaper(vault, metadata, "invalid-key", bibtex, ctx)).rejects.toMatchObject({ code: "INVALID_CITEKEY" });
  await expect(createPaper(vault, { ...metadata, authors: [] }, citekey, bibtex, ctx)).rejects.toMatchObject({ code: "INVALID_METADATA" });
  await expect(createPaper(vault, metadata, citekey, "<html>error</html>", ctx)).rejects.toMatchObject({ code: "INVALID_BIBTEX" });
  expect(await readdir(vault)).toEqual([]);
});

test("cannot silently skip an existing malformed paper while checking identities", async () => {
  await mkdir(join(vault, "library/papers"), { recursive: true });
  const bad = await readFile(new URL("../../../fixtures/sync-vault/research/ideas/坏文件.md", import.meta.url));
  await writeFile(join(vault, "library/papers/broken.md"), bad);
  await expect(createPaper(vault, metadata, citekey, bibtex, ctx)).rejects.toMatchObject({ code: "DUPLICATE_CHECK_FAILED" });
  expect(await readdir(join(vault, "library/papers"))).toEqual(["broken.md"]);
  expect(await readFile(join(vault, "library/papers/broken.md"))).toEqual(bad);
});

test("concurrent new paper creation never replaces another complete note", async () => {
  const secondCtx: FillContext = { ...ctx, newId: (prefix) => `${prefix}_01J9Z3K8M2N4P6Q8R0S2T4V6W9` };
  const results = await Promise.allSettled([
    createPaper(vault, metadata, citekey, bibtex, ctx),
    createPaper(vault, metadata, citekey, bibtex, secondCtx),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  expect(failure.reason.code).toBe("DUPLICATE_PAPER");
  const winnerCtx = results[0]!.status === "fulfilled" ? ctx : secondCtx;
  const bytes = await readFile(join(vault, "library/papers/He_2020_LightGCN.md"));
  expect(bytes.equals(renderPaper(metadata, citekey, bibtex, winnerCtx).content)).toBe(true);
  expect(Paper.safeParse(parseFrontmatter(bytes).data).success).toBe(true);
  expect(await readdir(join(vault, "library/papers"))).toEqual(["He_2020_LightGCN.md"]);
});

async function occupy(suffixes: string[]) {
  await mkdir(join(vault, "library/papers"), { recursive: true });
  return Promise.all(suffixes.map(async (suffix, index) => {
    const path = join(vault, `library/papers/${citekey}${suffix}.md`);
    const bytes = renderPaper({ ...metadata, doi: `10.1234/occupied${index}` }, citekey + suffix, bibtex, ctx).content;
    await writeFile(path, bytes);
    const info = await stat(path);
    return { path, bytes, mtime: info.mtimeMs, ino: info.ino };
  }));
}

test("suffixes use the first free letter, not the count of existing files", async () => {
  await occupy(["", "c"]);
  expect(await createPaper(vault, metadata, citekey, bibtex, ctx)).toBe("library/papers/He_2020_LightGCNb.md");
});

test("the last available suffix z is used and the filename, frontmatter and BibTeX agree", async () => {
  await occupy(["", ..."bcdefghijklmnopqrstuvwxy"]);
  const path = await createPaper(vault, metadata, citekey, bibtex, ctx);
  expect(path).toBe("library/papers/He_2020_LightGCNz.md");
  const parsed = parseFrontmatter(await readFile(join(vault, path)));
  expect(Paper.safeParse(parsed.data).success).toBe(true);
  expect(parsed.data.citekey).toBe("He_2020_LightGCNz");
  expect(parsed.body.toString()).toContain("@inproceedings{He_2020_LightGCNz,");
});

test("when base and b-z are occupied, report exhaustion without changing any file", async () => {
  const originals = await occupy(["", ..."bcdefghijklmnopqrstuvwxyz"]);
  await expect(createPaper(vault, metadata, citekey, bibtex, ctx)).rejects.toMatchObject({ code: "CITEKEY_EXHAUSTED" });
  for (const file of originals) {
    expect((await readFile(file.path)).equals(file.bytes)).toBe(true);
    expect((await stat(file.path)).mtimeMs).toBe(file.mtime);
    expect((await stat(file.path)).ino).toBe(file.ino);
  }
  expect(await readdir(join(vault, "library/papers"))).toHaveLength(26);
});

test("identity deduplication takes priority over a filename collision", async () => {
  const path = await createPaper(vault, metadata, citekey, bibtex, ctx);
  await expect(createPaper(vault, metadata, citekey, bibtex, ctx)).rejects.toMatchObject({ code: "DUPLICATE_PAPER" });
  expect(await readdir(join(vault, "library/papers"))).toEqual([path.slice("library/papers/".length)]);
});

test("two different papers racing for the same key get distinct complete files", async () => {
  const secondMetadata = { ...metadata, title: "Another synthetic paper", doi: "10.1234/other" };
  const paths = await Promise.all([
    createPaper(vault, metadata, citekey, bibtex, ctx),
    createPaper(vault, secondMetadata, citekey, bibtex, ctx),
  ]);
  expect(new Set(paths)).toEqual(new Set(["library/papers/He_2020_LightGCN.md", "library/papers/He_2020_LightGCNb.md"]));
  for (let index = 0; index < paths.length; index++) {
    const parsed = parseFrontmatter(await readFile(join(vault, paths[index]!)));
    expect(Paper.safeParse(parsed.data).success).toBe(true);
    expect(parsed.data.title).toBe(index === 0 ? metadata.title : secondMetadata.title);
  }
  expect(await readdir(join(vault, "library/papers"))).toHaveLength(2);
});
