import { z } from "zod";
import { Id, idOf } from "./common.ts";

/** POST /v2/security/review. This operation is human-only. */
export const SecurityReviewRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("note"), ref: Id, include_private: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("original"), ref: z.union([idOf("pap"), idOf("src")]) }),
  z.strictObject({ kind: z.literal("task"), ref: idOf("task") }),
  z.strictObject({ kind: z.literal("job"), ref: idOf("job") }),
]);
export type SecurityReviewRequest = z.infer<typeof SecurityReviewRequest>;

export const SecurityFinding = z.strictObject({
  reason: z.enum(["possible-card-number", "possible-api-key", "possible-private-key"]),
  field: z.enum(["file", "frontmatter", "body", "title", "description", "comment", "report", "question", "error", "engine_version"]),
  comment: idOf("wmsg").optional(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
});
export type SecurityFinding = z.infer<typeof SecurityFinding>;

export const SECURITY_REVIEW_MAX_FINDINGS = 1000;
export const SecurityReviewResult = z.strictObject({
  resource: SecurityReviewRequest,
  findings: z.array(SecurityFinding).max(SECURITY_REVIEW_MAX_FINDINGS),
  truncated: z.boolean(),
});
export type SecurityReviewResult = z.infer<typeof SecurityReviewResult>;
