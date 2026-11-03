import { lstat, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CoreError } from "@lumio/foundation";
import { renderIdea, entityDirectory, entityTypeOfPath, VAULT_LAYOUT, type NewNote, type FillContext } from "@lumio/knowledge";
import { writeFileAtomic } from "./write.ts";

export async function saveNewNote(vault: string, note: NewNote): Promise<string> {
  try {
    const type = entityTypeOfPath(note.relativePath);
    const name = type && note.relativePath.slice(entityDirectory(type).length + 1);
    if (!type || !name || !/^[^/\\]+\.md$/.test(name)) {
      const dirs = VAULT_LAYOUT.map((e) => `${e.dir}/`).join(", ");
      throw new CoreError("INVALID_NOTE_PATH", { key: "create.new_notes_must_be_directly_inside_the_type_directory", args: [dirs] });
    }
    if (!(await stat(vault)).isDirectory()) throw new Error("INVALID_VAULT");
    const segments = note.relativePath.split("/");
    const path = join(vault, ...segments);
    // 逐级创建并检查：大类目录（如 research/）和类型目录都不能是符号链接，否则会写到 vault 之外。
    let directory = vault;
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      try { await mkdir(directory); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
      if (!(await lstat(directory)).isDirectory()) throw new CoreError("INVALID_NOTE_DIRECTORY", { key: "create.note_directory_must_not_be_a_symbolic_link", args: [] });
    }
    await writeFileAtomic(path, note.content, { overwrite: false });
    return note.relativePath;
  } catch (cause) {
    if (cause instanceof CoreError) throw cause;
    throw new CoreError("CREATE_FAILED", { key: "create.could_not_create_note_check_that_vault_directory_exists_and_is_writa", args: [] }, { cause });
  }
}

export async function createIdea(vault: string, title: string, ctx: FillContext): Promise<string> {
  return saveNewNote(vault, renderIdea(title, ctx));
}
