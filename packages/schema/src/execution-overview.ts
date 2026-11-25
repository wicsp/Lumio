import { z } from "zod";
import { AGENTS, idOf, Timestamp } from "./common.ts";
import { JobStatus } from "./job.ts";

const count = z.number().int().nonnegative();
// SQLite substr counts Unicode code points, including a non-BMP character as one.
const excerpt = z.string().regex(/^[\s\S]{0,240}$/u);

export const ExecutionOverviewQuery = z.strictObject({ before: idOf("job").optional() });
export const ExecutionOverviewItem = z.strictObject({
  id: idOf("job"), status: JobStatus, created: Timestamp,
  task: idOf("task").optional(), routine: idOf("rtn").optional(), round: z.number().int().positive().optional(),
  label: excerpt, engine: z.enum(AGENTS).optional(), preview: excerpt.optional(),
});
export const ExecutionOverview = z.strictObject({
  activity: z.array(ExecutionOverviewItem).max(5),
  activity_live_count: count, execution_count: count,
  standalone_attention: z.strictObject({
    total: count, items: z.array(ExecutionOverviewItem).max(20), next_before: idOf("job").optional(),
  }),
});
export type ExecutionOverview = z.infer<typeof ExecutionOverview>;
export type ExecutionOverviewItem = z.infer<typeof ExecutionOverviewItem>;
