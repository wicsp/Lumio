import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@lumio/knowledge";
import { Entity } from "@lumio/schema";
import { syncVault } from "../src/sync.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/layout-vault", import.meta.url));
let temp: string;
let vault: string;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-layout-test-"));
  vault = join(temp, "vault");
  await cp(fixture, vault, { recursive: true });
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

async function sync(): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await syncVault(vault, { log: (line) => lines.push(line) });
  return { code, lines };
}

const NOT_SCANNED = [
  "research/ideas/草图.excalidraw.md", "create/posts/嵌入的画板.md", "research/reports/报告.md",
  "files/attachments/note.md", "files/drawings/画板.md", "files/templates/paper.md", ".obsidian/ignored.md", "根目录.md",
];

test("sync completes every type directory of the ADR 0012 layout and leaves non-entities untouched", async () => {
  const untouched = await Promise.all(NOT_SCANNED.map((p) => readFile(join(vault, p))));
  const { code, lines } = await sync();
  expect(lines.at(-1)).toBe("完成：扫描 8 个，补全 8 个，问题 0 个，跳过 0 个");
  expect(code).toBe(0);
  expect(lines.some((l) => l.includes("library/sources/obsidian/Excalidraw Essentials.md"))).toBe(true);
  for (const path of NOT_SCANNED) expect(lines.join("\n")).not.toContain(path);
  expect(await Promise.all(NOT_SCANNED.map((p) => readFile(join(vault, p))))).toEqual(untouched);

  const prefixes: Record<string, string> = {
    "library/sources/obsidian/Excalidraw Essentials.md": "src_",
    "create/posts/视频.md": "post_",
    "life/assets/subscriptions/Example Cloud.md": "ast_",
  };
  for (const [path, prefix] of Object.entries(prefixes)) {
    const data = parseFrontmatter(await readFile(join(vault, path))).data;
    expect(String(data.id).startsWith(prefix)).toBe(true);
    expect(Entity.safeParse(data).success).toBe(true);
  }
  expect((await sync()).lines).toEqual(["完成：扫描 8 个，补全 0 个，问题 0 个，跳过 0 个"]);
});

test("private assets are reported by path only, never by field content", async () => {
  const path = join(vault, "life/assets/subscriptions/Example Cloud.md");
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace("provider: Example Cloud Inc", "provider: Example Cloud Inc\nlogin: 4111 1111 1111 1111"));
  const { code, lines } = await sync();
  expect(code).toBe(1);
  const line = lines.find((l) => l.includes("life/assets/"))!;
  expect(line.startsWith("问题  life/assets/subscriptions/Example Cloud.md")).toBe(true);
  expect(line).toContain("login");
  expect(lines.join("\n")).not.toContain("4111");
  expect(lines.join("\n")).not.toContain("Example Cloud Inc");
});
