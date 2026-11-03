import { Idea } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { fillMetadata, type FillContext } from "./fill.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { entityDirectory } from "./layout.ts";

export interface NewNote { relativePath: string; content: Buffer }

export function renderIdea(title: string, ctx: FillContext): NewNote {
  if (!title.trim()) throw new CoreError("EMPTY_TITLE", { key: "create.title_must_not_be_empty_or_whitespace", args: [] });
  const fileName = title.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/gu, " ").trim();
  if (!fileName) throw new CoreError("INVALID_FILE_NAME", { key: "create.title_is_empty_after_removing_invalid_characters_cannot_generate_fil", args: [] });
  const original = { title };
  const { patch, issues } = fillMetadata({
    type: "idea", frontmatter: original, fileName,
    birthtime: ctx.now, mtime: ctx.now,
  }, ctx);
  const frontmatter = { ...original, ...patch };
  if (issues.length || !Idea.safeParse(frontmatter).success) {
    throw new CoreError("INVALID_METADATA", { key: "create.could_not_generate_valid_idea_metadata", args: [] });
  }
  return { relativePath: `${entityDirectory("idea")}/${fileName}.md`, content: parseFrontmatter("\n").render(frontmatter) };
}

