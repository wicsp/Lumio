import { text as msg } from "./messages.ts";
import { readFile } from "node:fs/promises";
import { vaultFileAt, buildBib, checkLinks, collectCitations, exportBib, noteLinks, searchNotes, showNote, type SearchOptions } from "@lumio/storage";
import { parseFrontmatter } from "@lumio/knowledge";
import { createClient } from "@lumio/api-client";
import { NOTE_TYPES, parseAssignee, type NoteRef } from "@lumio/schema";
import { KnowledgeService } from "@lumio/knowledge";
import { FileKnowledgeRepository } from "@lumio/storage";

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
  const local = root ? new KnowledgeService(new FileKnowledgeRepository(root)) : undefined;
  if (command.command === "export") {
    const citations = command.from === undefined ? undefined : await collectCitations(root!, command.from, { text: msg });
    for (const warning of citations?.warnings ?? []) warn(warning);
    if (citations && command.out === undefined) {
      const result = await buildBib(root!, citations.papers, msg);
      for (const warning of result.warnings) warn(warning);
      log(result.content.endsWith("\n") ? result.content.slice(0, -1) : result.content);
      return 0;
    }
    const result = await exportBib(root!, command.out, citations?.papers, msg);
    for (const warning of result.warnings) warn(warning);
    log(msg("query.exported_papers", result.count, result.path, result.changed ? "" : msg("query.unchanged")));
    return 0;
  }
  if (command.type !== undefined && !NOTE_TYPES.includes(command.type as NoteRef["type"])) throw new Error(msg("query.unknown_note_type"));
  if (command.limit !== undefined && !/^[1-9]\d*$/.test(command.limit)) throw new Error(msg("query.limit_must_be_a_positive_integer"));
  const options: SearchOptions = {
    includePrivate: command.includePrivate, type: command.type as NoteRef["type"] | undefined,
    ...(command.limit !== undefined ? { limit: Number(command.limit) } : {}),
  };
  if (command.command === "check") {
    const result = await (remote ? remote.check(options) : local!.check(options));
    // 沿用警告通道，JSON 与 Hub 的 CheckResult 契约保持原样。
    const list = (limit?: number) => remote ? remote.search("", { includePrivate: options.includePrivate, limit }) : local!.search("", { ...options, limit });
    let notes = await list();
    if (notes.hits.length < notes.total) notes = await list(notes.total);
    for (const { note } of notes.hits) {
      const reference = note.id ?? note.citekey ?? note.path.replace(/^.*\//, "").replace(/\.md$/, "");
      const file = remote ? undefined : await vaultFileAt(root!, note.path);
      const fm = remote ? (await remote.show(reference, options)).frontmatter : file ? parseFrontmatter(await readFile(file.path)).data : {};
      if (fm.assignee !== null && typeof fm.assignee === "object") {
        try {
          const assignee = parseAssignee(fm.assignee);
          if (assignee !== "human") warn(msg("query.hint_replace_the_legacy_assignee_object_with_assignee_e_g_pi_server", note.path, assignee.agent, assignee.device ? `@${assignee.device}` : ""));
        } catch { /* 格式错误由元数据校验报告，不把兼容性提示变成错误。 */ }
      }
      if (Object.hasOwn(fm, "turn")) warn(msg("query.hint_turn_is_no_longer_used_and_can_be_removed_dispatch_by_changing", note.path));
    }
    if (command.json) log(JSON.stringify(result));
    else if (!result.total) log(msg("query.no_dangling_links"));
    else {
      for (const link of result.dangling) log(`${link.from.path}  →  [[${link.target}]]`);
      log(msg("query.dangling_links", result.total));
    }
  } else if (command.command === "search") {
    const result = await (remote ? remote.search(command.argument, options) : local!.search(command.argument, options));
    if (command.json) log(JSON.stringify(result));
    else {
      log(msg("query.found_notes", result.total));
      for (const hit of result.hits) log(`${hit.note.title}  ${hit.note.path}\n  ${hit.snippet}`);
    }
  } else if (command.command === "show") {
    const result = await (remote ? remote.show(command.argument, options) : local!.show(command.argument, options));
    log(command.json ? JSON.stringify(result) : `${result.note.title}  ${result.note.path}\n${JSON.stringify(result.frontmatter, null, 2)}\n\n${result.body}`);
  } else {
    const result = await (remote ? remote.links(command.argument, options) : local!.links(command.argument, options));
    if (command.json) log(JSON.stringify(result));
    else {
      log(msg("query.outgoing_links", result.note.title, result.note.path));
      for (const link of result.outgoing) log(`  [${link.source}] ${link.target}${link.dangling ? msg("query.dangling") : ` → ${link.note!.path}`}`);
      log(msg("query.backlinks"));
      for (const link of result.incoming) log(`  [${link.source}] ${link.note.title}  ${link.note.path}`);
    }
  }
  return 0;
}
