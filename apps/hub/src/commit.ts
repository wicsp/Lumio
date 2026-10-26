import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openVaultGit, type GitTrailers } from "@lumio/core";
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
