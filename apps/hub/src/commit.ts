import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CoreError } from "@lumio/foundation";
import { openVaultGit, writeFileAtomic, type GitTrailers } from "@lumio/storage";
import { textContainsCardNumber } from "@lumio/schema";

/**
 * Hub 执行的写入立即单独提交，提交信息带 trailer 标明是谁做的（ADR 0016 第 5 节）。
 *
 * - 目标文件里有人还没提交的修改时，先把它们作为一次普通的自动保存提交（不带身份），再写入、再提交，
 *   保证归属清楚。
 * - 只提交这一个文件。git 不可用时只写入。提交失败不撤销写入（任务已经派出或结果已经写回），
 *   留给自动保存，并返回 false 让调用方记一条问题。
 * - 文件含疑似卡号时不提交（与自动保存的规则一致，ADR 0012）。
 */
export async function writeAndCommit(vault: string, relativePath: string, before: Buffer, write: () => Promise<void>,
  message: string, trailers: GitTrailers): Promise<boolean> {
  const git = await openVaultGit(vault);
  if (git && !textContainsCardNumber(before.toString("utf8")) && (await git.changedFiles()).includes(relativePath)) {
    try { await git.add(relativePath, before); await git.commit([relativePath], "lumio: auto-save 1 files"); } catch { /* 留给自动保存 */ }
  }
  await write();
  if (!git) return true;
  try {
    const after = await readFile(join(vault, relativePath));
    if (textContainsCardNumber(after.toString("utf8"))) return false;
    await git.add(relativePath, after);
    await git.commit([relativePath], message.replace(/[\r\n]+/g, " "), trailers);
    return true;
  } catch { return false; }
}

/**
 * 读-改-写一篇笔记；文件在中途被改了就重试，最多 3 次。
 * 给出 commit 时，写入后立即单独提交并带 trailer（ADR 0016 第 5 节）；提交失败调用 onCommitFailed，留给自动保存。
 */
export async function editNote(vault: string, path: string, change: (bytes: Buffer) => Buffer,
  commit: { message: string; trailers: GitTrailers } | undefined, onCommitFailed: () => void): Promise<void> {
  const file = join(vault, path);
  for (let attempt = 0; ; attempt++) {
    const bytes = await readFile(file);
    const next = change(bytes);
    if (next.equals(bytes)) return;
    try {
      const write = () => writeFileAtomic(file, next, { expectedContent: bytes }).then(() => {});
      if (!commit) { await write(); return; }
      if (!(await writeAndCommit(vault, path, bytes, write, commit.message, commit.trailers))) onCommitFailed();
      return;
    } catch (cause) { if (!(cause instanceof CoreError && cause.code === "FILE_CHANGED") || attempt >= 2) throw cause; }
  }
}
