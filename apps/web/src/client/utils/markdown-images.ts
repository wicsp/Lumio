const imagePattern = /!\[((?:\\[^\r\n]|[^\]\\\r\n])*)\]\(\s*(?:<([^\s<>]+)>|((?:[^\s()<>\\]|\\[()\\]|\([^\s()<>]*\))+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?[ \t]*\)/y;

export function markdownImageAt(source: string, from: number) {
  imagePattern.lastIndex = from;
  const match = imagePattern.exec(source);
  if (!match) return;
  return { from, to: imagePattern.lastIndex, alt: match[1]!.replace(/\\([\[\]\\])/g, "$1"), url: (match[2] ?? match[3]!).replace(/\\([()\\])/g, "$1") };
}

export function previewImageUrl(value: string, origins?: ReadonlySet<string>): string | undefined {
  if (!origins?.size || !/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return;
  try {
    const result = new URL(value);
    if (!result.username && !result.password && origins.has(result.origin)) return result.href;
  } catch { /* malformed destination */ }
}

export function imageMarkdown(filename: string, url: string): string {
  const alt = filename.replace(/\.[^.]+$/, "").replace(/[\r\n\t]/g, " ").trim().slice(0, 140).replace(/[[\]\\]/g, "\\$&");
  const target = url.replace(/[()]/g, value => value === "(" ? "%28" : "%29");
  return "![" + alt + "](" + target + ")";
}

export function noteImageInsert(line: { from: number; to: number }, position: number, length: number, markdown: string) {
  const from = position === line.from ? line.from : line.to;
  const before = from > line.from ? "\n" : "";
  const hasFollowingBreak = from === line.to && from < length;
  const insert = before + markdown + (hasFollowingBreak ? "" : "\n");
  return { from, insert, next: from + insert.length + (hasFollowingBreak ? 1 : 0) };
}
