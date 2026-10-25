// 子进程：在同一个索引上反复查询，并不时修改文件，迫使索引写入。供 index-concurrency.test.ts 使用。
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { searchNotes } from "../../src/index.ts";

const [vault, stateDir, tag, rounds] = process.argv.slice(2) as [string, string, string, string];
for (let i = 0; i < Number(rounds); i++) {
  if (i % 3 === 0) await appendFile(join(vault, "research/ideas", `${tag}.md`), `\n${tag}${i}\n`);
  await searchNotes(vault, "index", { stateDir });
}
