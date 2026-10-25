import { buildBib, checkLinks, collectCitations, excludedCardPaths, exportBib, noteLinks, searchNotes, showNote, type SearchOptions } from "@lumio/core";
import { createClient } from "@lumio/api-client";
import { NOTE_TYPES, type NoteRef } from "@lumio/schema";

export interface QueryCommand {
  command: "search" | "show" | "links" | "check" | "export";
  argument: string;
  type?: string;
  limit?: string;
  includePrivate?: boolean;
  json?: boolean;
  out?: string;
  from?: string;
}

export async function runQuery(root: string | undefined, command: QueryCommand, log: (line: string) => void, warn: (line: string) => void, remote?: ReturnType<typeof createClient>): Promise<number> {
  if (command.command === "export") {
    const citations = command.from === undefined ? undefined : await collectCitations(root!, command.from);
    for (const warning of citations?.warnings ?? []) warn(warning);
    if (citations && command.out === undefined) {
      const result = await buildBib(root!, citations.papers);
      for (const warning of result.warnings) warn(warning);
      log(result.content.endsWith("\n") ? result.content.slice(0, -1) : result.content);
      return 0;
    }
    const result = await exportBib(root!, command.out, citations?.papers);
    for (const warning of result.warnings) warn(warning);
    log(`导出 ${result.count} 篇论文：${result.path}${result.changed ? "" : "（未变化）"}`);
    return 0;
  }
  if (command.type !== undefined && !NOTE_TYPES.includes(command.type as NoteRef["type"])) throw new Error("未知笔记类型");
  if (command.limit !== undefined && !/^[1-9]\d*$/.test(command.limit)) throw new Error("limit 必须是正整数");
  const options: SearchOptions = {
    includePrivate: command.includePrivate, type: command.type as NoteRef["type"] | undefined,
    ...(command.limit !== undefined ? { limit: Number(command.limit) } : {}),
  };
  if (command.command === "check") {
    const result = await (remote ? remote.check(options) : checkLinks(root!, options));
    if (command.json) log(JSON.stringify(result));
    else if (!result.total) log("没有悬空链接");
    else {
      for (const link of result.dangling) log(`${link.from.path}  →  [[${link.target}]]`);
      log(`共 ${result.total} 条悬空链接`);
    }
  } else if (command.command === "search") {
    const result = await (remote ? remote.search(command.argument, options) : searchNotes(root!, command.argument, options));
    if (command.json) log(JSON.stringify(result));
    else {
      log(`找到 ${result.total} 篇笔记`);
      for (const hit of result.hits) log(`${hit.note.title}  ${hit.note.path}\n  ${hit.snippet}`);
      const paths = remote ? [] : await excludedCardPaths(root!, options);
      if (paths.length) log(`有 ${paths.length} 个文件因疑似含卡号未被索引\n${paths.join("\n")}`);
    }
  } else if (command.command === "show") {
    const result = await (remote ? remote.show(command.argument, options) : showNote(root!, command.argument, options));
    log(command.json ? JSON.stringify(result) : `${result.note.title}  ${result.note.path}\n${JSON.stringify(result.frontmatter, null, 2)}\n\n${result.body}`);
  } else {
    const result = await (remote ? remote.links(command.argument, options) : noteLinks(root!, command.argument, options));
    if (command.json) log(JSON.stringify(result));
    else {
      log(`${result.note.title}  ${result.note.path}\n出链：`);
      for (const link of result.outgoing) log(`  [${link.source}] ${link.target}${link.dangling ? "（悬空）" : ` → ${link.note!.path}`}`);
      log("反向链接：");
      for (const link of result.incoming) log(`  [${link.source}] ${link.note.title}  ${link.note.path}`);
    }
  }
  return 0;
}
