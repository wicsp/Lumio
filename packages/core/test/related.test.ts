import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { appendRelatedId, parseFrontmatter } from "../src/frontmatter.ts";

const base = await readFile(new URL("../../../fixtures/query-vault/research/ideas/Literal.md", import.meta.url));
const id = "pap_00000000000000000000000001";
const existing = "idea_00000000000000000000000004";
function source(field: string) { return Buffer.from(base.toString().replace("type: idea", `type: idea\n${field}`)); }

test("append preserves the exact body and all other metadata for absent, null, block and flow related", () => {
  for (const field of ["", "related:", "related: null # keep", "related: ~", `related: [${existing}] # keep`, `related: [${existing},] # keep`, "related: []", `related:\n  - ${existing} # keep`]) {
    for (const crlf of [false, true]) {
      const original = crlf ? Buffer.from(source(field).toString().replaceAll("\n", "\r\n")) : source(field);
      const result = appendRelatedId(original, id);
      const before = parseFrontmatter(original), after = parseFrontmatter(result);
      expect(after.body).toEqual(before.body);
      expect(after.data).toEqual({ ...before.data, related: [...(before.data.related as string[] ?? []), id] });
      if (field.includes("# keep")) expect(result.toString()).toContain("# keep");
      if (field.startsWith("related: [")) expect(result.toString()).toContain("related: [");
      if (field.startsWith("related:\n")) expect(result.toString()).toContain(`- ${id}`);
      expect(appendRelatedId(result, id)).toEqual(result);
    }
  }
});

test("only related changes, including following-field comments and non-UTF8 body bytes", () => {
  for (const field of [`related: [${existing}] # list\n# title comment`, `related:\n  - ${existing} # item\n# title comment`]) {
    const original = Buffer.concat([source(field), Buffer.from([0xff, 0xfe, 0x00])]);
    const result = appendRelatedId(original, id);
    const expected = field.includes("[")
      ? original.toString("latin1").replace(`[${existing}]`, `[${existing}, ${id}]`)
      : original.toString("latin1").replace(`# item\n`, `# item\n  - ${id}\n`);
    expect(result).toEqual(Buffer.from(expected, "latin1"));
  }
});

test("malformed related and edits that change alias-owned fields are refused", () => {
  for (const field of ["related: broken", "related: 7", "related: { key: value }", `related: &links [${existing}]\nother: *links`]) {
    expect(() => appendRelatedId(source(field), id)).toThrow();
  }
});
