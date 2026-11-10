import { describe, expect, test } from "bun:test";
import { renderInline, renderMarkdown } from "../../src/client/utils/markdown.ts";
import { MESSAGE_SEPARATOR, aiNoteIdOf, referenceConsequence, resourceRoute } from "../../src/client/resources.ts";
import { aiNoteLine } from "../../src/client/ai-note-embed.ts";

// ADR 0051（K4-4）：lumio: 链接、来源跳转与 AI 笔记嵌入的纯函数部分。只用合成 ID。
const ULID = "01JA0000000000000000000000";
const ain = `ain_${ULID}`, amsg = `amsg_${ULID}`, conv = `conv_${ULID}`, job = `job_${ULID}`, task = `task_${ULID}`;

describe("lumio: links", () => {
  test("render as in-app resource links that carry only the ID", () => {
    const html = renderInline(`[当时的讨论](lumio:${amsg})`);
    expect(html).toBe(`<a href="#" class="resource-link" data-resource="${amsg}">当时的讨论</a>`);
    expect(renderMarkdown(`see [run](lumio:${job}) and [web](https://example.com)`)).toContain(`data-resource="${job}"`);
  });
  test("malformed or unknown IDs stay inert text", () => {
    for (const href of ["lumio:amsg_x", `lumio://${amsg}`, `lumio:zzz_${ULID}`, "lumio:"]) {
      const html = renderInline(`[x](${href})`);
      expect(html).toBe("x");
    }
    expect(renderInline(`[x" onclick="evil](lumio:${amsg})`)).not.toContain('onclick="evil');
  });
});

describe("AI note embeds", () => {
  test("AI notes are recognised from their ID file name", () => {
    expect(aiNoteIdOf(ain)).toBe(ain);
    expect(aiNoteIdOf(`ai/notes/${ain}.md`)).toBe(ain);
    expect(aiNoteIdOf(`../../ai/notes/${ain}.md`)).toBe(ain);
    expect(aiNoteIdOf("research/ideas/ain_summary.md")).toBeUndefined();
    expect(aiNoteIdOf(`idea_${ULID}`)).toBeUndefined();
  });
  test("only a link alone on its own line becomes a card", () => {
    expect(aiNoteLine(`[[${ain}]]`)).toEqual({ id: ain, label: "" });
    expect(aiNoteLine(`  [[${ain}|AI 摘要]]  `)).toEqual({ id: ain, label: "AI 摘要" });
    expect(aiNoteLine(`[AI 摘要](../../ai/notes/${ain}.md)`)).toEqual({ id: ain, label: "AI 摘要" });
    expect(aiNoteLine(`见 [[${ain}]]`)).toBeUndefined();
    expect(aiNoteLine(`[[${ain}]] 之后的话`)).toBeUndefined();
    expect(aiNoteLine(`![img](ai/notes/${ain}.md)`)).toBeUndefined();
    expect(aiNoteLine(`[x](lumio:${ain})`)).toBeUndefined();
  });
});

describe("resource routes", () => {
  const visible = (id: string, parent?: string) => ({ id, status: "visible" as const, title: "Synthetic", ...(parent ? { parent } : {}) });
  test("each module opens its own page", () => {
    expect(resourceRoute(visible(ain))).toEqual(["knowledge", ain]);
    expect(resourceRoute(visible(conv))).toEqual(["assistant", conv]);
    expect(resourceRoute(visible(amsg, conv))).toEqual(["assistant", `${conv}${MESSAGE_SEPARATOR}${amsg}`]);
    expect(resourceRoute(visible(task))).toEqual(["work", task]);
    expect(resourceRoute(visible(`wmsg_${ULID}`, task))).toEqual(["work", task]);
    expect(resourceRoute(visible(job))).toEqual(["execution", job]);
    expect(resourceRoute(visible(`evt_${ULID}`, job))).toEqual(["execution", job]);
    expect(resourceRoute(visible(`act_${ULID}`))).toBeUndefined();
  });
  test("delete confirmation mentions citing knowledge only when there is any", () => {
    expect(referenceConsequence(undefined)).toEqual([]);
    expect(referenceConsequence(0)).toEqual([]);
    expect(referenceConsequence(2)).toHaveLength(1);
  });
});
