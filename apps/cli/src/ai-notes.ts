import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { AI_NOTE_CAPABILITY_NAMES, KnowledgeAiNoteCommand } from "@lumio/schema";
import { ApiClientError, createClient } from "@lumio/api-client";
import { language } from "@lumio/platform";
import { hubCredentials } from "./config.ts";
import { text as msg } from "./messages.ts";

export async function runAiNote(args: string[], log: (line: string) => void): Promise<number> {
  const [action, ...rest] = args;
  const invalid = () => new ApiClientError({ code: "INVALID", message: msg("ai_note.invalid") });
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      json: { type: "boolean" }, file: { type: "string" }, tags: { type: "string" }, sources: { type: "string" },
      "request-id": { type: "string" }, title: { type: "string" }, model: { type: "string" }, revision: { type: "string" },
    },
  });
  const create = action === "create";
  if ((!create && action !== "update") || positionals.length !== 1
    || (create ? !values.file || values.title !== undefined || values.revision !== undefined : values.model !== undefined || !values.revision)) throw invalid();
  const parseList = (value?: string): unknown => {
    if (value === undefined) return;
    try { return JSON.parse(value); } catch { throw invalid(); }
  };
  const body = values.file ? await (values.file === "-" ? Bun.stdin.text() : Bun.file(values.file).text()) : undefined;
  const fields = { body, tags: parseList(values.tags), derived_from: parseList(values.sources) };
  const command = KnowledgeAiNoteCommand.safeParse({
    request_id: values["request-id"] ?? randomUUID(),
    operation: create
      ? { op: AI_NOTE_CAPABILITY_NAMES[0], args: { ...fields, title: positionals[0], model: values.model } }
      : { op: AI_NOTE_CAPABILITY_NAMES[1], args: { ...fields, note: positionals[0], title: values.title, expected_revision: values.revision } },
  });
  if (!command.success) throw invalid();
  const result = await createClient({ ...hubCredentials(), language: language() }).aiNoteCommand(command.data);
  log(values.json ? JSON.stringify(result) : `${result.note.id}  ${result.note.path}  ${result.revision}`);
  return 0;
}
