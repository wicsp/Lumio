import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CoreError } from "@lumio/foundation";
import { aiNoteFileName, parseFrontmatter, VAULT_LAYOUT } from "@lumio/knowledge";
import { OriginalFrontmatter, textContainsCardNumber } from "@lumio/schema";
import { writeFileAtomic } from "./write.ts";

const directory = VAULT_LAYOUT.originals;
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const missing = (cause?: unknown) => new CoreError("NOTE_NOT_FOUND", { key: "query.note_not_found_candidates_none", args: [] }, { cause });

export function isOriginalPath(path: string): boolean {
  if (!path.startsWith(directory + "/")) return false;
  const name = path.slice(directory.length + 1);
  return !name.startsWith(".") && !/[\\/]/.test(name) && name.endsWith(".md");
}

async function originalDirectory(root: string, create = false): Promise<string | undefined> {
  let path = root;
  for (const part of directory.split("/")) {
    path = join(path, part);
    try {
      if (create) await mkdir(path).catch(cause => {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      });
      if (!(await lstat(path)).isDirectory()) {
        if (create) throw missing();
        return;
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
  }
  return path;
}

export async function scanOriginals(root: string): Promise<{ path: string; relativePath: string }[]> {
  const path = await originalDirectory(root);
  if (!path) return [];
  return (await readdir(path, { withFileTypes: true })).flatMap(entry => {
    const relativePath = `${directory}/${entry.name}`;
    return entry.isFile() && isOriginalPath(relativePath) ? [{ path: join(path, entry.name), relativePath }] : [];
  });
}

export function parseOriginal(bytes: Buffer) {
  const { data, body } = parseFrontmatter(bytes);
  const frontmatter = OriginalFrontmatter.safeParse(data);
  if (!frontmatter.success || frontmatter.data.sha256 !== hash(body) || !Buffer.from(body.toString("utf8")).equals(body)) throw missing();
  return { frontmatter: frontmatter.data, body: body.toString("utf8") };
}

export async function originalBytes(root: string, path: string): Promise<Buffer> {
  if (!isOriginalPath(path) || !await originalDirectory(root)) throw missing();
  try {
    const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw missing();
      return await handle.readFile();
    } finally { await handle.close(); }
  } catch (cause) { throw missing(cause); }
}

export async function readOriginalFile(root: string, path: string) {
  const bytes = await originalBytes(root, path);
  if (textContainsCardNumber(bytes.toString("utf8"))) throw missing();
  return parseOriginal(bytes);
}

/** Publish complete bytes; replacement requires the same path and owner. */
export async function writeOriginal(
  root: string,
  input: Omit<OriginalFrontmatter, "sha256"> & { title: string; body: string },
  replace?: string,
): Promise<{ path: string; frontmatter: OriginalFrontmatter }> {
  const { title, body, ...metadata } = input;
  const content = Buffer.from(body);
  const parsed = OriginalFrontmatter.safeParse({ ...metadata, sha256: hash(content) });
  if (!parsed.success || !body.trim()) throw new CoreError("INVALID_METADATA", { key: "create.could_not_generate_valid_idea_metadata", args: [] });
  const frontmatter = parsed.data;
  const path = replace ?? `${directory}/${aiNoteFileName(title, frontmatter.of)}.md`;
  const bytes = Buffer.concat([parseFrontmatter("").render(frontmatter), content]);
  if (textContainsCardNumber(bytes.toString("utf8"))) throw new CoreError("INVALID_METADATA", { key: "create.could_not_generate_valid_idea_metadata", args: [] });
  let expectedContent: Buffer | undefined;
  if (replace) {
    expectedContent = await originalBytes(root, replace);
    if (parseOriginal(expectedContent).frontmatter.of !== frontmatter.of) throw missing();
  } else await originalDirectory(root, true);
  await writeFileAtomic(join(root, path), bytes, { overwrite: !!replace, expectedContent });
  return { path, frontmatter };
}
