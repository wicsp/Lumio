import { expect, test } from "bun:test";
import { humanPart, parseFrontmatter, setFields, upsertBlock } from "../src/index.ts";

const note = Buffer.from(`---
id: task_00000000000000000000000001
type: task
title: 加 XML 包装
status: todo   # 人改
turn: agent
assignee: {agent: codex, device: server}
---
要求：加一种 XML 包装。
`);

test("setFields replaces existing scalars in place and appends missing ones; nothing else changes", () => {
  const out = setFields(note, { turn: "human", status: "active" });
  expect(out.toString()).toContain("status: active   # 人改");
  expect(out.toString()).toContain("turn: human");
  expect(parseFrontmatter(out).body.equals(parseFrontmatter(note).body)).toBe(true);
  expect(out.toString().replace("active", "todo").replace("turn: human", "turn: agent")).toBe(note.toString());
  const added = setFields(Buffer.from("---\ntitle: x\n---\nbody\n"), { turn: "human" });
  expect(parseFrontmatter(added).data).toEqual({ title: "x", turn: "human" });
});

test("humanPart drops AI blocks", () => {
  const body = "我的要求\n\n<!-- lumio:ai start name=round-1 job=job_x -->\n### 第 1 轮\n汇报\n<!-- lumio:ai end name=round-1 -->\n\n我的意见\n";
  expect(humanPart(body)).toBe("我的要求\n\n我的意见");
});

test("upsertBlock appends once, then replaces the same block; human text untouched", () => {
  const first = upsertBlock(note, "round-1", "job=job_a", "### 第 1 轮 · 完成\n汇报 A");
  const text = first.toString();
  expect(text.startsWith(note.toString())).toBe(true);
  expect(text).toContain("<!-- lumio:ai start name=round-1 job=job_a -->\n### 第 1 轮 · 完成\n汇报 A\n<!-- lumio:ai end name=round-1 -->\n");
  const withReply = Buffer.from(text + "\n我的意见\n");
  const replaced = upsertBlock(withReply, "round-1", "job=job_a", "### 第 1 轮 · 完成\n汇报 B").toString();
  expect(replaced).toContain("汇报 B"); expect(replaced).not.toContain("汇报 A");
  expect(replaced.endsWith("\n我的意见\n")).toBe(true);
  const second = upsertBlock(Buffer.from(replaced), "round-2", "job=job_b", "### 第 2 轮").toString();
  expect(second.indexOf("round-1")).toBeLessThan(second.indexOf("round-2"));
  expect(humanPart(parseFrontmatter(Buffer.from(second)).body.toString())).toBe("要求：加一种 XML 包装。\n\n我的意见");
});
