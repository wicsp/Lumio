import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  Asset, CONTRACTS, Entity, Post, Source,
} from "../src/index.ts";

// 与 packages/core 读取 frontmatter 时相同的 YAML 解析（eemeli/yaml，YAML 1.2）。
const root = join(import.meta.dir, "..", "..", "..", "fixtures", "schema");
function load(dir: string) {
  return readdirSync(join(root, dir)).filter((f) => f.endsWith(".md")).map((file) => {
    const text = readFileSync(join(root, dir, file), "utf8");
    const header = text.match(/^---\n([\s\S]*?)\n---/)![1]!;
    return { file, header, data: parse(header) as Record<string, unknown> };
  });
}

describe("valid fixtures", () => {
  test.each(load("valid").map((f) => [f.file, f] as const))("%s", (_, { data }) => {
    const result = Entity.safeParse(data);
    if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
  });
});

describe("invalid fixtures report the expected field", () => {
  test.each(load("invalid").map((f) => [f.file, f] as const))("%s", (_, { header, data }) => {
    const expected = header.match(/^# expect: (.+)$/m)![1]!.trim();
    const result = Entity.safeParse(data);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((issue) => issue.path.join("."));
    expect(paths.some((path) => path === expected || path.startsWith(`${expected}.`))).toBe(true);
  });
});

describe("defaults and empty fields (ADR 0008)", () => {
  const base = { id: "src_01J9Z3K8M2N4P6Q8R0S2T4V6W8", title: "x", created: "2026-10-23T17:30:00+08:00", updated: "2026-10-23T17:30:00+08:00" };

  test("source defaults", () => {
    expect(Source.parse({ ...base, type: "source" })).toMatchObject({ kind: "web", status: "to-read" });
    expect(Source.parse({ ...base, type: "source", kind: null, url: null }).kind).toBe("web");
  });

  test("post defaults; empty targets and media", () => {
    const post = Post.parse({ ...base, type: "post", id: "post_01J9Z3K8M2N4P6Q8R0S2T4V6W8", format: "text", media: null, targets: null });
    expect(post).toMatchObject({ status: "idea", derived_from: [], media: {}, targets: [] });
  });

  test("target status defaults to pending", () => {
    const post = Post.parse({ ...base, type: "post", id: "post_01J9Z3K8M2N4P6Q8R0S2T4V6W8", format: "text", targets: [{ platform: "x" }] });
    expect(post.targets[0]!.status).toBe("pending");
  });

  test("unquoted last4 0123 keeps its leading zero", () => {
    const asset = Asset.parse(parse(`type: asset\nid: ast_01J9Z3K8M2N4P6Q8R0S2T4V6W8\ntitle: x\ncreated: ${base.created}\nupdated: ${base.updated}\nkind: card\nlast4: 0123`));
    expect(asset.last4).toBe("0123");
  });
});

test("new contracts export to JSON Schema", () => {
  for (const name of ["source", "post", "asset"] as const) {
    expect(() => z.toJSONSchema(CONTRACTS[name], { io: "input" })).not.toThrow();
  }
});
