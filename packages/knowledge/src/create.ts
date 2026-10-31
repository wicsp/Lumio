import { Idea } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { fillMetadata, type FillContext } from "./fill.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { entityDirectory } from "./layout.ts";

export interface NewNote { relativePath: string; content: Buffer }

export function renderIdea(title: string, ctx: FillContext): NewNote {
  if (!title.trim()) throw new CoreError("EMPTY_TITLE", "标题不能为空或只有空白");
  const fileName = title.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/gu, " ").trim();
  if (!fileName) throw new CoreError("INVALID_FILE_NAME", "标题替换非法字符后为空，无法生成文件名");
  const original = { title };
  const { patch, issues } = fillMetadata({
    type: "idea", frontmatter: original, fileName,
    birthtime: ctx.now, mtime: ctx.now,
  }, ctx);
  const frontmatter = { ...original, ...patch };
  if (issues.length || !Idea.safeParse(frontmatter).success) {
    throw new CoreError("INVALID_METADATA", "无法生成合法的想法元数据");
  }
  return { relativePath: `${entityDirectory("idea")}/${fileName}.md`, content: parseFrontmatter("\n").render(frontmatter) };
}

