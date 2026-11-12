import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Asset, CONTRACTS, Entity, ID_PREFIXES, MediaRef, NOTE_TYPES, Post, Source } from "../src/index.ts";

type Case = Record<string, unknown>;
const cases = JSON.parse(readFileSync(join(import.meta.dir, "../../../fixtures/entities/cases.json"), "utf8")) as {
  valid: Record<string, Case>;
  invalid: Record<string, Case>;
};

describe("ADR 0012 entities: fixtures", () => {
  test.each(Object.entries(cases.valid))("accepts %s", (_, fm) => {
    const result = Entity.safeParse(fm);
    if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  });

  test.each(Object.entries(cases.invalid))("rejects %s", (_, fm) => {
    expect(Entity.safeParse(fm).success).toBe(false);
  });
});

describe("new ID prefixes and registries", () => {
  test("prefixes", () => {
    expect(ID_PREFIXES).toMatchObject({ source: "src", post: "post", asset: "ast" });
  });

  test("contracts and note types include the new types", () => {
    for (const type of ["source", "post", "asset"] as const) {
      expect(CONTRACTS[type]).toBeDefined();
      expect(NOTE_TYPES).toContain(type);
    }
  });
});

describe("Source", () => {
  test("defaults", () => {
    const parsed = Source.parse(cases.valid["source-minimal"]);
    expect(parsed.kind).toBe("web");
    expect(parsed.status).toBe("to-read");
  });

  test("null fields are absent or default (ADR 0008)", () => {
    const parsed = Source.parse(cases.valid["source-podcast-nulls"]);
    expect(parsed.url).toBeUndefined();
    expect(parsed.status).toBe("to-read");
  });
});

describe("MediaRef", () => {
  test.each(["files/attachments/a.png", "media://2026-10/a.mp4", "a.mp4", "media://a b/c.mov"])("accepts %s", (ref) => {
    expect(MediaRef.safeParse(ref).success).toBe(true);
  });

  test.each(["", "/a.mp4", "../a.mp4", "a/../b.mp4", "media://", "media:///a.mp4", "media://../a.mp4", "a\\b.mp4", "https://x/a.mp4", "file:a.mp4", "a//b.mp4"])(
    "rejects %s",
    (ref) => expect(MediaRef.safeParse(ref).success).toBe(false),
  );
});

describe("Post", () => {
  test("fills defaults, including target status", () => {
    const parsed = Post.parse(cases.valid["post-null-defaults"]);
    expect(parsed).toMatchObject({ status: "idea", media: {}, targets: [], derived_from: [] });
    const video = Post.parse(cases.valid["post-video"]);
    expect(video.targets[2]?.status).toBe("pending");
    expect(video.targets[3]?.format).toBe("gallery");
  });

  test("a target pointing at a missing media role is reported on that target", () => {
    const result = Post.safeParse(cases.invalid["post-target-unknown-media"]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["targets", 0, "media"]);
  });

  test("keeps unknown top-level fields", () => {
    const parsed = Post.parse({ ...cases.valid["post-text-minimal"], cssclasses: ["wide"] });
    expect(parsed).toMatchObject({ cssclasses: ["wide"] });
  });
});

describe("Asset", () => {
  test("defaults and accepted date shapes", () => {
    expect(Asset.parse(cases.valid["asset-card"]).status).toBe("active");
    expect(Asset.parse(cases.valid["asset-card"]).expires).toBe("2028-09");
    expect(Asset.parse(cases.valid["asset-domain"]).expires).toBe("2027-03-14");
  });

  test("short digit runs (dates, last4, prices) are not flagged", () => {
    expect(Asset.safeParse({ ...cases.valid["asset-subscription"], title: "订单 20261023 共 1200 元" }).success).toBe(true);
  });
});

describe("JSON Schema export", () => {
  test("new contracts convert", () => {
    for (const schema of [Source, Post, Asset]) {
      expect(() => z.toJSONSchema(schema, { io: "input" })).not.toThrow();
    }
  });
});
