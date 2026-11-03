import { Citekey, Paper } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { rewriteBibtexKey } from "./bibtex.ts";
import type { NewNote } from "./create.ts";
import { fillMetadata, type FillContext } from "./fill.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type { PaperMetadata } from "./paper-metadata.ts";
import { entityDirectory } from "./layout.ts";

export function renderPaper(metadata: PaperMetadata, citekey: string, bibtex: string, ctx: FillContext): NewNote {
  const msg = ctx.text ?? ((key: string, ...args: unknown[]) => key.replace(/\$\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])));
  if (!Citekey.safeParse(citekey).success) {
    throw new CoreError("INVALID_CITEKEY", { key: "paper.paper_citekey_does_not_match_contract", args: [] });
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
  if (issues.length || !Paper.safeParse(frontmatter).success) throw new CoreError("INVALID_METADATA", { key: "paper.could_not_generate_valid_paper_metadata", args: [] });
  const rewritten = rewriteBibtexKey(bibtex, citekey);
  const body = ["", msg("## One sentence"), "", msg("## My notes"), "", msg("## Points to cite"), "", msg("## Relation to my research"), "", "## BibTeX", "", "```bibtex", rewritten, "```", ""].join("\n");
  return { relativePath: `${entityDirectory("paper")}/${citekey}.md`, content: parseFrontmatter(body).render(frontmatter) };
}

