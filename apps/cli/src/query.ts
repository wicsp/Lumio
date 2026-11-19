import { text as msg } from "./messages.ts";
import { buildBib, checkLinks, collectCitations, exportBib, noteLinks, searchNotes, showNote, type SearchOptions } from "@lumio/storage";
import { createClient } from "@lumio/api-client";
import { lumioLink, NOTE_TYPES, type NoteRef } from "@lumio/schema";
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
    if (command.json) log(JSON.stringify(result));
    else {
      for (const path of result.unsupported_work_notes) log(msg("query.unsupported_work_note", path));
      for (const link of result.dangling) log(`${link.from.path}  →  [[${link.target}]]`);
      log(result.total ? msg("query.dangling_links", result.total) : msg("query.no_dangling_links"));
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
      for (const { task } of result.work_incoming ?? []) log(`  [${msg("query.task_reference")}] ${task.title}  ${lumioLink(task.id)}`);
    }
  }
  return 0;
}
