import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Citekey, textContainsCardNumber } from "@lumio/schema";
import { rewriteBibtexKey } from "./bibtex.ts";
import { CoreError } from "./errors.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { entityDirectory, scanVault } from "./vault.ts";
import { writeFileAtomic } from "./write.ts";

export interface BibExport { path: string; changed: boolean; count: number; warnings: string[] }

function bibtexBlock(body: string): string | undefined {
  let section = false;
  let fence: { character: string; length: number; bibtex: boolean } | undefined;
  let content: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        if (fence.bibtex) return content.join("\n").trim();
        fence = undefined;
      } else if (fence.bibtex) content.push(line);
      continue;
    }
    if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length, bibtex: section && marker[2]!.trim().toLowerCase() === "bibtex" };
      content = [];
      continue;
    }
    const heading = /^ {0,3}(#{1,2})[ \t]+(.*)$/.exec(line);
    if (heading) section = heading[1] === "##" && heading[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim().toLowerCase() === "bibtex";
  }
  return undefined;
}

export async function exportBib(root: string, out?: string): Promise<BibExport> {
  try {
    const entries: { key: string; path: string; text: string }[] = [];
    const warnings: string[] = [];
    for (const file of await scanVault(root, ["paper"])) {
      if (file.private) continue;
      const raw = await readFile(file.path);
      if (textContainsCardNumber(raw.toString("utf8"))) {
        warnings.push(`疑似含卡号，跳过：${file.relativePath}`); continue;
      }
      try {
        const { data, body } = parseFrontmatter(raw);
        if (!Citekey.safeParse(data.citekey).success) {
          warnings.push(`缺少合法 citekey，跳过：${file.relativePath}`); continue;
        }
        const original = bibtexBlock(body.toString("utf8"));
        if (original === undefined) { warnings.push(`缺少 BibTeX 一节或代码块，跳过：${file.relativePath}`); continue; }
        const text = rewriteBibtexKey(original, data.citekey as string);
        if (text !== original) warnings.push(`BibTeX key 已纠正：${file.relativePath}`);
        entries.push({ key: data.citekey as string, path: file.relativePath, text });
      } catch (cause) {
        if (!(cause instanceof CoreError)) throw cause;
        warnings.push(`无法解析 frontmatter 或 BibTeX，跳过：${file.relativePath}`);
      }
    }
    entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.path < b.path ? -1 : 1);
    const path = out ?? join(root, entityDirectory("paper"), "..", "refs.bib");
    const content = `% 本文件由 lumio 生成，请勿手动编辑\n\n${entries.map((e) => e.text).join("\n\n")}${entries.length ? "\n" : ""}`;
    await mkdir(dirname(path), { recursive: true });
    const changed = await writeFileAtomic(path, Buffer.from(content));
    return { path, changed, count: entries.length, warnings };
  } catch (cause) {
    if (cause instanceof CoreError) throw cause;
    throw new CoreError("BIB_EXPORT_FAILED", "无法导出 BibTeX", { cause });
  }
}
