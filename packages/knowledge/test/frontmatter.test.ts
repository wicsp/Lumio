import { expect, test } from "bun:test";
import { CoreError } from "@lumio/foundation";
import { parseFrontmatter } from "../src/index.ts";

test.each(["\n", "\r\n"])("body bytes, old formatting, comments and key order survive %j", (nl) => {
  const header = ["---", "# 注释", "title: '保持引号' # inline", "aliases: &a [甲, 乙]", "custom: *a", "related: [pap_01J9Z3K8M2N4P6Q8R0S2T4V6W8]", ""].join(nl);
  const body = Buffer.concat([Buffer.from(`${nl}中文 [[链接]]  ${nl}\`\`\`yaml${nl}---${nl}`), Buffer.from([0xff, 0, 10])]);
  const bytes = Buffer.concat([Buffer.from(header + "---" + nl), body]);
  const parsed = parseFrontmatter(bytes);
  const result = parsed.render({ id: "idea_01J9Z3K8M2N4P6Q8R0S2T4V6W8", updated: "2026-10-22T20:00:00+08:00" });
  expect(result.subarray(0, Buffer.byteLength(header))).toEqual(Buffer.from(header));
  const reread = parseFrontmatter(result);
  expect(reread.body).toEqual(body);
  expect(reread.data).toMatchObject({ ...parsed.data, id: "idea_01J9Z3K8M2N4P6Q8R0S2T4V6W8" });
  expect(Object.keys(reread.data)).toEqual([...Object.keys(parsed.data), "id", "updated"]);
  expect(parsed.render({})).toEqual(bytes);
});

test.each(["", "# 标题\n正文 [[链接]]\n", "--- horizontal rule without closing"])("creates frontmatter without changing body %j", (body) => {
  const parsed = parseFrontmatter(body);
  expect(parsed.data).toEqual({});
  expect(parseFrontmatter(parsed.render({ title: "new" })).body).toEqual(Buffer.from(body));
});

test.each(["id:\n", "id: # 保留注释\n", "id: null # 保留注释\n", "id: ~\n"])("fills empty ID safely: %j", (header) => {
  const result = parseFrontmatter(`---\n${header}title: old\n---\nbody`).render({ id: "idea_00000000000000000000000000", type: "idea" });
  expect(parseFrontmatter(result).data).toEqual({ id: "idea_00000000000000000000000000", title: "old", type: "idea" });
  if (header.includes("#")) expect(result.toString()).toContain("# 保留注释");
});

test.each(["{ title: old } # comment\n", "{ title: old, }\n", "{ title: old, # comment\n}\n", "{}\n", "  title: old\n", "title: old\n... # end\n", "# only comment\n"])("supports YAML mapping formatting %j", (header) => {
  const result = parseFrontmatter(`---\n${header}---\nbody`).render({ id: "idea_00000000000000000000000000" });
  expect(parseFrontmatter(result).data.id).toBe("idea_00000000000000000000000000");
  expect(parseFrontmatter(result).body.toString()).toBe("body");
  if (header.includes("title")) expect(result.toString()).toContain("title: old");
  if (header.includes("# comment")) expect(result.toString()).toContain("# comment");
});

test("keeps UTF-8 BOM and an EOF closing delimiter", () => {
  const result = parseFrontmatter("\ufeff---\r\ntitle: old\r\n---").render({ type: "idea" });
  expect(result.toString().startsWith("\ufeff---\r\ntitle: old\r\n")).toBe(true);
  expect(result.toString().endsWith("---")).toBe(true);
  expect(parseFrontmatter(result).body.length).toBe(0);
});

test.each(["---\ntitle: [broken\n---\nbody", "---\ntitle: a\ntitle: b\n---\nbody", "---\n- sequence\n---\n", "---\nscalar\n---\n", "---\nfoo: *missing\n---\n", "---\ntitle: no closing delimiter"])("invalid YAML produces a coded library error: %j", (source) => {
  try { parseFrontmatter(source); }
  catch (cause) { expect(cause).toBeInstanceOf(CoreError); expect(cause).toMatchObject({ code: "INVALID_FRONTMATTER" }); return; }
  throw new Error("expected parse error");
});

test("refuses to overwrite existing fields", () => {
  expect(() => parseFrontmatter("---\ntitle: old\n---\nbody").render({ title: "new" })).toThrow(CoreError);
});

test("refuses edits whose YAML tags or anchors would change existing values", () => {
  for (const header of ["id: !!null null\n", "id: &empty null\ncustom: *empty\n"]) {
    expect(() => parseFrontmatter(`---\n${header}---\nbody`).render({ id: "idea_00000000000000000000000000" }))
      .toThrow(CoreError);
  }
});

test.each(["\n", "\r\n"])("replaces all null metadata in place without duplicate keys: %j", (nl) => {
  const header = ["updated: # updated comment", "title: null # title comment", "citekey: ~", "id:", "type: null", "created:", "aliases: [keep]", ""].join(nl);
  // Deliberately use a different patch order than the source key order.
  const patch = { id: "pap_01J9Z3K8M2N4P6Q8R0S2T4V6W8", type: "paper", title: "中文标题", created: "2026-10-22T21:00:00+08:00", updated: "2026-10-22T22:00:00+08:00", citekey: "He_2020_LightGCN" };
  const body = Buffer.concat([Buffer.from(`正文 [[链接]]${nl}`), Buffer.from([0xff])]);
  const source = Buffer.concat([Buffer.from(`---${nl}${header}---${nl}`), body]);
  const rendered = parseFrontmatter(source).render(patch);
  const parsed = parseFrontmatter(rendered);
  expect(parsed.data).toEqual({ ...patch, aliases: ["keep"] });
  expect(Object.keys(parsed.data)).toEqual(["updated", "title", "citekey", "id", "type", "created", "aliases"]);
  expect(parsed.body).toEqual(body);
  expect(rendered.toString()).toContain("# updated comment");
  expect(rendered.toString()).toContain("# title comment");
  for (const key of Object.keys(patch)) expect(rendered.toString().match(new RegExp(`^${key}:`, "gm"))).toHaveLength(1);
});

test("multiple null replacements in a flow map preserve original order and allow new keys", () => {
  const rendered = parseFrontmatter("---\n{ updated: null, title: ~, id: null, } # preserve\n---\nbody").render({ id: "idea_01J9Z3K8M2N4P6Q8R0S2T4V6W8", title: "idea", updated: "2026-10-22T22:00:00+08:00", type: "idea" });
  const parsed = parseFrontmatter(rendered);
  expect(Object.keys(parsed.data)).toEqual(["updated", "title", "id", "type"]);
  expect(parsed.data.title).toBe("idea");
  expect(rendered.toString()).toContain("# preserve");
});

test("an existing empty string cannot be replaced", () => {
  expect(() => parseFrontmatter('---\ntitle: ""\n---\nbody').render({ title: "new" })).toThrow(CoreError);
});
