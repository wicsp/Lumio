import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CoreError } from "./errors.ts";

export interface GitTrailers {
  "Lumio-Actor"?: string;
  "Lumio-Proposal"?: string;
  "Lumio-Approved-By"?: string;
  /** 写回某一轮结果时，这一轮的 Job ID（P2-4）。 */
  "Lumio-Job"?: string;
}

export interface VaultGit {
  changedFiles(): Promise<string[]>;
  add(path: string, expectedContent?: Uint8Array | null): Promise<void>;
  commit(paths: string[], message: string, trailers?: GitTrailers): Promise<void>;
}

/** Only the vault's own .git is accepted; never discover a parent repository. */
export async function openVaultGit(root: string, executable = "git"): Promise<VaultGit | undefined> {
  const vault = resolve(root);
  const staged = new Map<string, string>();
  async function run(args: string[], options: { index?: string; input?: string } = {}): Promise<Buffer> {
    try {
      const proc = Bun.spawn([executable, "--literal-pathspecs", "-C", vault, ...args], {
        stdout: "pipe", stderr: "pipe", stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) },
      });
      const [stdout, , code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error("git failed");
      return Buffer.from(stdout);
    } catch (cause) { throw new CoreError("GIT_FAILED", "无法执行 vault git 操作", { cause }); }
  }
  function check(path: string) {
    const rel = relative(vault, resolve(vault, path));
    if (!rel || isAbsolute(path) || rel.startsWith("../") || rel === "..") throw new CoreError("GIT_FAILED", "git 路径必须在 vault 内");
  }
  try {
    const info = await lstat(join(vault, ".git"));
    if (!info.isFile() && !info.isDirectory()) return;
    if (await realpath((await run(["rev-parse", "--show-toplevel"])).toString().trim()) !== await realpath(vault)) return;
  } catch { return; }
  return {
    async changedFiles() {
      // Disable rename detection: both sides become individual paths, including deletions.
      const output = (await run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).toString();
      return [...new Set(output.split("\0").filter(Boolean).map((entry) => entry.slice(3)))];
    },
    async add(path, expectedContent) {
      check(path); staged.delete(path);
      await run(["add", "--", path]);
      const entry = (await run(["ls-files", "--stage", "-z", "--", path])).toString();
      const match = /^(\d+) ([a-f0-9]+) 0\t/.exec(entry);
      if (expectedContent !== undefined) {
        const matches = expectedContent === null ? !entry : match && (await run(["cat-file", "blob", match[2]!])).equals(expectedContent);
        if (!matches) throw new CoreError("FILE_CHANGED", "文件在暂存时被修改，请等待下次自动提交");
      }
      // Cache the exact staged object, not a path that commit could re-read later.
      staged.set(path, entry || `0 ${"0".repeat(40)}\t${path}\0`);
    },
    async commit(paths, message, trailers = {}) {
      if (Object.entries(trailers).some(([key, value]) => !["Lumio-Actor", "Lumio-Proposal", "Lumio-Approved-By", "Lumio-Job"].includes(key) || !value || /[\r\n]/.test(value))) throw new CoreError("GIT_FAILED", "git trailer 不合法");
      if (!paths.length) return;
      paths.forEach(check);
      if (paths.some((path) => !staged.has(path))) throw new CoreError("GIT_FAILED", "提交路径尚未暂存");
      const temp = await mkdtemp(join(tmpdir(), "lumio-git-index-"));
      const index = join(temp, "index");
      try {
        // Build a temporary index from HEAD plus only the checked snapshots.
        // This also excludes unrelated content already staged by a person.
        let hasHead = true;
        try { await run(["rev-parse", "--verify", "HEAD"]); } catch { hasHead = false; }
        await run(hasHead ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], { index });
        await run(["update-index", "-z", "--index-info"], { index, input: paths.map((path) => staged.get(path)!).join("") });
        const suffix = Object.entries(trailers).map(([key, value]) => `${key}: ${value}`).join("\n");
        const changed = !hasHead || (await run(["diff-index", "--cached", "--name-only", "-z", "HEAD"], { index })).length > 0;
        if (changed) await run(["commit", "-m", message + (suffix ? `\n\n${suffix}` : "")], { index });
        for (const path of paths) staged.delete(path);
      } finally { await rm(temp, { recursive: true, force: true }); }
    },
  };
}
