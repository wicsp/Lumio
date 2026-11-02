import { Citekey, Paper } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { rewriteBibtexKey } from "./bibtex.ts";
import type { NewNote } from "./create.ts";
import { fillMetadata, type FillContext } from "./fill.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type { PaperMetadata } from "./paper-metadata.ts";
import { entityDirectory } from "./layout.ts";

export function renderPaper(metadata: PaperMetadata, citekey: string, bibtex: string, ctx: FillContext): NewNote {
  if (!Citekey.safeParse(citekey).success) {
    throw new CoreError("INVALID_CITEKEY", "论文 citekey 不符合契约");
  }
  const original: Record<string, unknown> = {
    title: metadata.title, citekey, authors: metadata.authors, year: metadata.year,
  };
  for (const key of ["arxiv", "doi", "url", "venue"] as const) {
    if (metadata[key]) original[key] = metadata[key];
  }
  const { patch, issues } = fillMetadata({
    type: "paper", frontmatter: original, fileName: citekey,
    birthtime: ctx.now, mtime: ctx.now,
  }, ctx);
  const frontmatter = { ...original, ...patch };
  if (issues.length || !Paper.safeParse(frontmatter).success) throw new CoreError("INVALID_METADATA", "无法生成合法的论文元数据");
  const rewritten = rewriteBibtexKey(bibtex, citekey);
  const body = ["", "## 一句话", "", "## 我的笔记", "", "## 可以引用的点", "", "## 和我的研究的关系", "", "## BibTeX", "", "```bibtex", rewritten, "```", ""].join("\n");
  return { relativePath: `${entityDirectory("paper")}/${citekey}.md`, content: parseFrontmatter(body).render(frontmatter) };
}

