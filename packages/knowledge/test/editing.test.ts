import { test, expect } from "bun:test";
import { editKnowledgeDocument, parseFrontmatter, rankRelated, referenceText, lexicalTerms, searchableText } from "../src/index.ts";
import type { NoteRef } from "@lumio/schema";
const note = (title: string, path = `research/ideas/${title}.md`): NoteRef => ({ type: "idea", title, path });
test("editing preserves unknown YAML values, comments, identity and raw body; a no-op is byte-identical", () => {
    const original = Buffer.from('---\r\n# keep this comment\r\nid: idea_00000000000000000000000004\r\ntype: idea\r\ntitle: Before\r\ncreated: 2026-01-01T00:00:00Z\r\nupdated: 2026-01-01T00:00:00Z\r\ncustom:\r\n  nested: [null, false, 3]\r\n---\r\n<!-- lumio:ai start -->\n```bibtex\n@article{a}\n```\n<!-- lumio:ai end -->');
    const before = parseFrontmatter(original), body = before.body.toString() + "\n| unknown | table |\n";
    expect(editKnowledgeDocument(original, "Before", before.body.toString(), "2026-11-06T00:00:00Z")).toBe(original);
    const after = editKnowledgeDocument(original, "A new: title", body, "2026-11-06T00:00:00Z"), parsed = parseFrontmatter(after);
    expect(parsed.data).toEqual({ ...before.data, title: "A new: title", updated: "2026-11-06T00:00:00Z" });
    expect(parsed.body.toString()).toBe(body);
    expect(after.toString()).toContain("# keep this comment\r\n");
    expect(parsed.data.tags).toBeUndefined();
});
test("ranking uses actual matching paragraphs, Chinese short terms and bounded typo matching", () => {
    const notes = [{ note: note("A"), body: "Unrelated introduction.\n\n知识检索 connects research evidence." }, { note: note("B"), body: "retrieval evidence" }, { note: note("Knowledge"), body: "Nothing relevant." }];
    const chinese = rankRelated(notes, { title: "", text: "", focus: "知识检索" });
    expect(chinese[0]!.snippet).toContain("知识检索");
    expect(chinese[0]!.snippet).not.toContain("introduction");
    const typo = rankRelated(notes, { title: "", text: "", focus: "" }, "retrieva");
    expect(typo[0]!.note.title).toBe("B");
    expect(typo[0]!.snippet).toBe("retrieval evidence");
    const titleOnly = rankRelated(notes, { title: "Knowledge", text: "", focus: "" });
    expect(titleOnly[0]!.snippet).toBe("");
    expect(lexicalTerms("X", true)).toEqual(["x"]);
    expect(lexicalTerms("trial中文")).toEqual(["trial", "中文"]);
    expect(lexicalTerms("and the a")).toEqual([]);
    expect(searchableText("[^ref]: [[Unrelated]]\n\ntext[^ref]")).toBe("\n\ntext");
});
test("ambiguous and unsafe filenames use relative Markdown links, including nested sources", () => {
    expect(referenceText("research/ideas/nested/current.md", note("Long title", "library/papers/paper.md"), true)).toBe("[[paper|Long title]]");
    expect(referenceText("research/ideas/nested/current.md", note("Long title", "library/papers/paper.md"), false)).toBe("[Long title](../../../library/papers/paper.md)");
    expect(referenceText("research/ideas/current.md", note("[brackets]", "library/sources/a#b.md"), true)).toBe("[\\[brackets\\]](../../library/sources/a%23b.md)");
});
