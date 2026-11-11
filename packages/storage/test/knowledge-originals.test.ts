import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { capturedNoteBody, entityDirectory, entityTypeOfPath, parseFrontmatter, VAULT_LAYOUT } from "@lumio/knowledge";
import { KnowledgeOriginal, SearchResult, Source } from "@lumio/schema";
import { knowledgeGraph, scanVault, searchNotes, showOriginal, writeOriginal } from "../src/index.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/i1-inbox/", import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "lumio-original-"));
  directories.push(root);
  const vault = join(root, "vault"), source = join(vault, entityDirectory("source"), "Synthetic Article.md");
  const options = { stateDir: join(root, "state") };
  const sourceBytes = await readFile(join(fixture, "source.md"));
  await mkdir(join(vault, entityDirectory("source")), { recursive: true });
  await writeFile(source, sourceBytes);
  const note = Source.parse(parseFrontmatter(sourceBytes).data);
  const input = { of: note.id, title: note.title, url: note.url, captured: note.created, extractor: "pasted@1", lang: "en",
    body: await readFile(join(fixture, "original.md"), "utf8") };
  return { vault, source, note, input, options };
}

test("originals resolve to their public entity and contribute a lower-priority search match without becoming notes or links", async () => {
  const { vault, source, note, input, options } = await sandbox();
  await searchNotes(vault, "", options);
  using old = new Database(join(options.stateDir, "index.sqlite"));
  old.exec("DROP TABLE originals_fts; DROP TABLE original_files");
  const original = await writeOriginal(vault, input);
  expect(original.path).toBe(`${VAULT_LAYOUT.originals}/Synthetic Article ${note.id}.md`);
  expect(entityTypeOfPath(original.path)).toBeUndefined();
  expect(await scanVault(vault)).toHaveLength(1);
  expect(KnowledgeOriginal.parse(await showOriginal(vault, "Synthetic Article", options))).toMatchObject({
    body: input.body, path: original.path, frontmatter: original.frontmatter, note: { id: note.id },
  });
  for (const query of ["xenolithmarker", "短词"]) {
    const result = SearchResult.parse(await searchNotes(vault, query, options));
    expect(result.total).toBe(1);
    expect(result.hits[0]).toMatchObject({
      note: { id: note.id, type: "source" }, matched_in: "original", status: "reference", created: note.created,
    });
    expect(result.hits[0]!.snippet).toContain(query);
  }
  expect(await searchNotes(vault, "sharedphrase", options)).toMatchObject({ total: 1, hits: [{ matched_in: "body" }] });
  expect((await searchNotes(vault, "xenolithmarker", { ...options, type: "paper" })).total).toBe(0);
  expect(await knowledgeGraph(vault, options)).toMatchObject({ nodes: [{ id: note.id }], edges: [], dangling: 0 });
  await rename(source, join(vault, "outside.md"));
  expect((await searchNotes(vault, "xenolithmarker", options)).total).toBe(0);
  await expect(showOriginal(vault, note.id, options)).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
});

test("explicit replacement preserves the path, verifies the digest, and rejects symlinks", async () => {
  const { vault, input, options } = await sandbox();
  const original = await writeOriginal(vault, input);
  await expect(writeOriginal(vault, input)).rejects.toMatchObject({ code: "FILE_EXISTS" });
  const updated = await writeOriginal(vault, { ...input, title: "Changed title", body: "New extracted passage" }, original.path);
  expect(updated.path).toBe(original.path);
  expect(updated.frontmatter.sha256).not.toBe(original.frontmatter.sha256);
  expect((await searchNotes(vault, "xenolithmarker", options)).total).toBe(0);
  expect((await searchNotes(vault, "New extracted", options)).total).toBe(1);
  const path = join(vault, original.path);
  await writeFile(path, (await readFile(path, "utf8")).replace("New extracted passage", "Changed without digest"));
  expect((await searchNotes(vault, "Changed without digest", options)).total).toBe(0);
  await expect(showOriginal(vault, input.of, options)).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  await rename(path, join(vault, "moved.md"));
  await symlink(join(vault, "moved.md"), path);
  await expect(writeOriginal(vault, input, original.path)).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
});

test("the captured template starts with one standalone AI note link", () => {
  expect(capturedNoteBody("\n## My notes\n\n", "library/sources/A.md", "ai/notes/Card (sample) ain_01J00000000000000000000000.md", "AI note"))
    .toBe("[AI note](../../ai/notes/Card%20%28sample%29%20ain_01J00000000000000000000000.md)\n\n## My notes\n\n");
});
