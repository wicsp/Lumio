import { SECURITY_REVIEW_MAX_FINDINGS, SecurityReviewRequest, SecurityReviewResult, type SecurityFinding } from "@lumio/schema";
import { readNoteForReview, showOriginal } from "@lumio/storage";
import type { WorkService } from "@lumio/work";
import type { HubConfig } from "./config.ts";
import type { HubStore } from "./store.ts";
import { assertNoteVisible } from "./trash.ts";
import { HubError } from "./errors.ts";
import { boundedText } from "./knowledge-authoring.ts";
import { Jobs } from "./jobs.ts";

const CARD_LAYOUTS = [
  /(?<![\d-])\d{13,19}(?![\d-])/g,
  /(?<![\d-])\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{1,3})?(?![\d-])/g,
  /(?<![\d-])\d{4}([ -])\d{6}\1\d{5}(?![\d-])/g,
];
const API_KEY = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}\b|xox[abprs]-[A-Za-z0-9-]{10,}|lumio_[A-Za-z0-9_-]{43}\b)/g;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g;

function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

type Location = Pick<SecurityFinding, "field" | "comment">;
type Section = Location & { text: string };

function* scan({ text, ...location }: Section): Generator<SecurityFinding> {
  const lines = text.split(/\r\n|[\r\n]/);
  for (const [index, line] of lines.entries()) {
    const findings: SecurityFinding[] = [];
    const add = (reason: SecurityFinding["reason"], match: RegExpMatchArray) =>
      findings.push({ ...location, reason, line: index + 1, column: match.index! + 1 });
    for (const layout of CARD_LAYOUTS) {
      for (const match of line.matchAll(layout)) {
        if (luhnValid(match[0].replace(/[ -]/g, ""))) add("possible-card-number", match);
      }
    }
    for (const match of line.matchAll(API_KEY)) add("possible-api-key", match);
    for (const match of line.matchAll(PRIVATE_KEY)) add("possible-private-key", match);
    yield* findings.sort((a, b) => a.column - b.column);
  }
}

async function* readSections(resource: SecurityReviewRequest, { vault, stateDir }: HubConfig, work: WorkService, store: HubStore): AsyncGenerator<Section> {
  if (resource.kind === "task") {
    const { task, comments } = work.detail(resource.ref);
    yield { field: "title", text: task.title };
    yield { field: "description", text: task.description };
    for (const comment of comments) yield { field: "comment", comment: comment.id, text: comment.body };
    return;
  }
  if (resource.kind === "job") {
    const { result } = new Jobs(store).get(resource.ref);
    for (const field of ["report", "question", "error"] as const) {
      const text = result?.[field];
      if (text) yield { field, text };
    }
    if (result?.engine) yield { field: "engine_version", text: result.engine.version };
    return;
  }
  if (!vault) throw new HubError("INVALID", { key: "knowledge.no_vault", args: [] });
  assertNoteVisible(store.db, resource.ref);
  if (resource.kind === "note") {
    const text = await readNoteForReview(vault, resource.ref, { stateDir, includePrivate: resource.include_private });
    assertNoteVisible(store.db, resource.ref);
    yield { field: "file", text };
    return;
  }
  const detail = await showOriginal(vault, resource.ref, { stateDir, readOnly: true });
  if (detail.note.id !== resource.ref) throw new HubError("NOT_FOUND", { key: "query.note_not_found_candidates_none", args: [] });
  assertNoteVisible(store.db, resource.ref);
  yield { field: "frontmatter", text: JSON.stringify(detail.frontmatter, null, 2) };
  yield { field: "body", text: detail.body };
}

export async function reviewSecurity(request: Request, config: HubConfig, work: WorkService, store: HubStore): Promise<Response> {
  const invalid = () => new HubError("INVALID", { key: "capability.invalid", args: [] });
  let input: unknown;
  try { input = JSON.parse(await boundedText(request.body, 4096)); }
  catch { throw invalid(); }
  const resource = SecurityReviewRequest.safeParse(input);
  if (!resource.success) throw invalid();
  const findings: SecurityFinding[] = [];
  let truncated = false;
  scanResource: for await (const section of readSections(resource.data, config, work, store)) {
    for (const finding of scan(section)) {
      if (findings.length === SECURITY_REVIEW_MAX_FINDINGS) {
        truncated = true;
        break scanResource;
      }
      findings.push(finding);
    }
  }
  return Response.json(SecurityReviewResult.parse({ resource: resource.data, findings, truncated }),
    { headers: { "Cache-Control": "no-store" } });
}
