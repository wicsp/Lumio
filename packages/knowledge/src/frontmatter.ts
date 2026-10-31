import { Id } from "@lumio/schema";
import { Document, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { isDeepStrictEqual } from "node:util";
import { CoreError } from "@lumio/foundation";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: Buffer;
  render(patch: Record<string, unknown>): Buffer;
}

/** Parse YAML with its syntax tree; retain the original bytes outside edited ranges. */
export function parseFrontmatter(source: string | Uint8Array): Frontmatter {
  const bytes = Buffer.from(source);
  // Delimiters are ASCII; latin1 gives byte offsets even when the body isn't UTF-8.
  const raw = bytes.toString("latin1");
  const opening = /^(?:\xef\xbb\xbf)?---[ \t]*(\r?\n)/.exec(raw);
  let header = "";
  let body = bytes;
  let before = Buffer.alloc(0);
  let closing = Buffer.alloc(0);
  let newline = "\n";
  if (opening) {
    newline = opening[1]!;
    const end = /^---[ \t]*(?:\r?\n|$)/m.exec(raw.slice(opening[0].length));
    if (!end) throw new CoreError("INVALID_FRONTMATTER", "frontmatter 缺少结束分隔符");
    const start = opening[0].length;
    const closeStart = start + end.index;
    before = bytes.subarray(0, start);
    header = bytes.subarray(start, closeStart).toString("utf8");
    closing = bytes.subarray(closeStart, closeStart + end[0].length);
    body = bytes.subarray(closeStart + end[0].length);
  }
  try {
    const doc = parseDocument(header, { keepSourceTokens: true, strict: true });
    if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) {
      throw new Error(doc.errors.map((e) => e.message).join("; ") || "frontmatter 必须是键值映射");
    }
    if (isMap(doc.contents) && doc.contents.items.some(({ key }) => !isScalar(key) || typeof key.value !== "string")) {
      throw new Error("frontmatter 的键必须是字符串");
    }
    const data = (doc.toJS({ maxAliasCount: 100 }) ?? {}) as Record<string, unknown>;
    return {
      data, body,
      render(patch) {
        try {
          if (Object.keys(patch).length === 0) return bytes;
          let updated = header;
          const additions = new Document();
          const replacements: { start: number; end: number; text: string }[] = [];
          for (const [key, value] of Object.entries(patch)) {
            if (Object.hasOwn(data, key)) {
              if (data[key] !== null) {
                throw new CoreError("EXISTING_METADATA", `不能覆盖已有字段 ${key}`);
              }
              const node = doc.get(key, true);
              if (!isScalar(node) || !node.range) throw new CoreError("INVALID_FRONTMATTER", `无法定位空字段 ${key}`);
              const [start, end] = node.range;
              const replacement = new Document(value).toString().trimEnd();
              const text = start === end ? ` ${replacement} ` : replacement;
              replacements.push({ start, end, text });
            } else additions.set(key, value);
          }
          // Ranges refer to the original source. Work backwards so replacing
          // several null fields cannot shift any pending replacement's offsets.
          for (const { start, end, text } of replacements.sort((a, b) => b.start - a.start)) {
            updated = updated.slice(0, start) + text + updated.slice(end);
          }
          if (isMap(additions.contents) && additions.contents.items.length) {
            if (isMap(doc.contents) && doc.contents.flow) {
              additions.contents.flow = true;
              const text = additions.toString({ lineWidth: 0 }).trim();
              // Insert after the last value, before its comments or an optional trailing comma.
              const last = doc.contents.items.at(-1)?.value;
              const end = last && typeof last === "object" && "range" in last
                ? (last.range as [number, number, number])[1] : doc.contents.range![0] + 1;
              const at = end + updated.length - header.length;
              const comma = doc.contents.items.length ? ", " : " ";
              updated = updated.slice(0, at) + comma + text.slice(1, -1).trim() + " " + updated.slice(at);
            } else {
              const start = doc.contents?.range?.[0] ?? 0;
              const indent = header.slice(header.lastIndexOf("\n", start - 1) + 1, start);
              const text = additions.toString({ lineWidth: 0 }).split("\n")
                .map((line) => line ? indent + line : line).join(newline);
              const docEnd = /^\.\.\.[ \t]*(?:#.*)?\r?$/m.exec(updated);
              const at = docEnd?.index ?? updated.length;
              const prefix = updated.slice(0, at);
              updated = prefix + (prefix && !prefix.endsWith("\n") ? newline : "") + text + updated.slice(at);
            }
          }
          // Verify the splice before a caller can write it. YAML anchors/tags must
          // never make an edit change the values of other, existing fields.
          const check = parseDocument(updated);
          if (check.errors.length || check.warnings.length > doc.warnings.length
            || !isDeepStrictEqual(check.toJS({ maxAliasCount: 100 }), { ...data, ...patch })) {
            throw new CoreError("UNSAFE_FRONTMATTER_EDIT", "无法在保留已有字段的前提下补全 frontmatter");
          }
          if (!opening) {
            return Buffer.concat([Buffer.from(`---${newline}${updated}---${newline}`), body]);
          }
          return Buffer.concat([before, Buffer.from(updated), closing, body]);
        } catch (cause) {
          if (cause instanceof CoreError) throw cause;
          throw new CoreError("FRONTMATTER_WRITE_FAILED", "无法生成 frontmatter", { cause });
        }
      },
    };
  } catch (cause) {
    if (cause instanceof CoreError) throw cause;
    throw new CoreError("INVALID_FRONTMATTER", "frontmatter 不是合法 YAML", { cause });
  }
}
