import { isDeepStrictEqual } from "node:util";
import { Document, isScalar, parseDocument } from "yaml";
import { CoreError } from "./errors.ts";
import { parseFrontmatter } from "./frontmatter.ts";

/**
 * 任务笔记的编辑（ADR 0019 第 2、3 节，P2-4）。都只改需要改的字节：
 * frontmatter 的其他字段、写法与注释，正文中 AI 区块以外的部分，都逐字节保持不变。
 */

/**
 * 设置 frontmatter 中的字符串字段：已有的标量值就地替换，缺失的追加。
 * 与补全器的 render 不同，这里允许覆盖已有值，只给 Hub 维护的程序字段（turn、status）使用。
 */
export function setFields(source: Uint8Array, patch: Record<string, string>): Buffer {
  const bytes = Buffer.from(source);
  const parsed = parseFrontmatter(bytes);
  const raw = bytes.toString("latin1");
  const opening = /^(?:\xef\xbb\xbf)?---[ \t]*\r?\n/.exec(raw);
  const missing: Record<string, string> = {};
  let result: Buffer = bytes;
  if (opening) {
    const end = /^---[ \t]*(?:\r?\n|$)/m.exec(raw.slice(opening[0].length))!;
    const start = opening[0].length, close = start + end.index;
    let header = bytes.subarray(start, close).toString("utf8");
    const doc = parseDocument(header, { keepSourceTokens: true });
    const replacements: { start: number; end: number; text: string }[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const node = Object.hasOwn(parsed.data, key) ? doc.get(key, true) : undefined;
      if (node === undefined) { missing[key] = value; continue; }
      if (!isScalar(node) || !node.range) throw new CoreError("UNSAFE_FRONTMATTER_EDIT", `无法定位字段 ${key}`);
      const text = new Document(value).toString().trimEnd();
      const [from, to] = node.range;
      replacements.push({ start: from, end: to, text: from === to ? ` ${text}` : text });
    }
    for (const r of replacements.sort((a, b) => b.start - a.start)) header = header.slice(0, r.start) + r.text + header.slice(r.end);
    result = Buffer.concat([bytes.subarray(0, start), Buffer.from(header), bytes.subarray(close)]);
  } else Object.assign(missing, patch);
  if (Object.keys(missing).length) result = parseFrontmatter(result).render(missing);
  const check = parseFrontmatter(result);
  if (!isDeepStrictEqual(check.data, { ...parsed.data, ...patch }) || !check.body.equals(parsed.body)) {
    throw new CoreError("UNSAFE_FRONTMATTER_EDIT", "无法在保留其他字段的前提下修改 frontmatter");
  }
  return result;
}

const AI_BLOCK = /<!--\s*lumio:ai start\b[^>]*-->[\s\S]*?<!--\s*lumio:ai end\b[^>]*-->[ \t]*\r?\n?/g;

/** 正文里"人写的部分"：去掉所有 AI 区块。 */
export function humanPart(body: string): string {
  return body.replace(AI_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 追加或替换一个 AI 区块（按 name 识别）。替换时只改这个区块；追加时放在正文末尾，前面空一行。
 * `attrs` 写在开始标记里，如 `job=job_…`。
 */
export function upsertBlock(source: Uint8Array, name: string, attrs: string, content: string): Buffer {
  if (!/^[a-z0-9][a-z0-9_.:-]*$/.test(name)) throw new CoreError("INVALID_FRONTMATTER", "AI 区块名称不合法");
  const bytes = Buffer.from(source);
  const parsed = parseFrontmatter(bytes);
  const body = parsed.body.toString("utf8");
  if (!Buffer.from(body, "utf8").equals(parsed.body)) throw new CoreError("UNSAFE_FRONTMATTER_EDIT", "正文不是 UTF-8，无法安全写入");
  const prefix = bytes.subarray(0, bytes.length - parsed.body.length);
  const block = `<!-- lumio:ai start name=${name}${attrs ? ` ${attrs}` : ""} -->\n${content.trim()}\n<!-- lumio:ai end name=${name} -->\n`;
  const existing = new RegExp(`<!--\\s*lumio:ai start name=${name.replace(/[.]/g, "\\.")}(?:\\s[^>]*)?-->[\\s\\S]*?<!--\\s*lumio:ai end name=${name.replace(/[.]/g, "\\.")}\\s*-->[ \\t]*\\r?\\n?`);
  const next = existing.test(body)
    ? body.replace(existing, () => block)
    : `${body}${!body.trim() ? "" : body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n"}${block}`;
  return Buffer.concat([prefix, Buffer.from(next, "utf8")]);
}
