import type { createClient } from "@lumio/api-client";
import type { JobActivityEvent } from "@lumio/schema";
import { text as msg } from "./messages.ts";

function label(event: JobActivityEvent): string {
  switch (event.type) {
    case "phase": return msg("jobs.activity_phase", event.phase);
    case "tool_started": return msg("jobs.activity_tool_started", event.tool.label);
    case "tool_finished": return msg("jobs.activity_tool_finished", event.tool.label, event.outcome);
    case "engine": return msg("jobs.activity_engine", event.activity);
    case "error": return msg("jobs.activity_error", event.category);
    case "omitted": return msg("jobs.activity_gap");
    case "request_opened": return msg("jobs.activity_waiting");
    case "request_closed": return msg("jobs.activity_decided", event.outcome);
  }
}
export async function watchJob(client: ReturnType<typeof createClient>, url: string, id: string, log: (line: string) => void, json: boolean,
  delay: (milliseconds: number) => Promise<unknown>) {
  let after = 0, previous = "", offline = false;
  for (;;) {
    let live: Awaited<ReturnType<typeof client.jobLive>>, page: Awaited<ReturnType<typeof client.jobEvents>>;
    try {
      live = await client.jobLive(id);
      page = await client.jobEvents(id, { after });
    } catch (cause) {
      if (!previous || (cause instanceof Error && "status" in cause && [400, 401, 403, 404].includes(Number(cause.status)))) throw cause;
      if (!offline && !json) log(msg("jobs.activity_connection_retry"));
      offline = true;
      await delay(1500);
      continue;
    }
    if (offline && !json) log(msg("jobs.activity_connection_restored"));
    offline = false;
    after = page.next_after;
    const signature = JSON.stringify([live.status, live.connected, live.phase, live.pending?.id, live.stop_requested, live.sequence, live.receipts]);
    if (signature !== previous || page.events.length || page.gap) {
      if (json) {
        const { pending, ...safe } = live;
        log(JSON.stringify({ live: { ...safe, pending: pending ? { kind: pending.kind, expires: pending.expires } : null }, page }));
      } else {
        if (signature !== previous) log(`${id}  ${live.status}${live.connected === false ? msg("jobs.runtime_disconnected") : ""}  ${live.last_activity ?? live.last_heartbeat ?? "—"}`);
        if (!previous && !live.capability?.progress && !live.sequence) log(msg("jobs.activity_unavailable"));
        if (page.gap) log(msg("jobs.activity_gap"));
        for (const record of page.events) log(`${record.event.at}  ${label(record.event)}`);
        if (live.pending) log(msg("jobs.activity_visit", `${url.replace(/\/$/, "")}/#execution/${id}`));
      }
      previous = signature;
    }
    if (page.has_more) continue;
    if (!["queued", "assigned", "running"].includes(live.status)) {
      // Result can arrive before the Runtime's final activity batch.
      if (live.sequence && live.phase !== "finishing") {
        await delay(800);
        const finalPage = await client.jobEvents(id, { after }).catch(() => undefined);
        if (finalPage?.events.length) {
          if (json) log(JSON.stringify({ page: finalPage }));
          else for (const record of finalPage.events) log(`${record.event.at}  ${label(record.event)}`);
        }
      }
      return live.status === "failed" || live.status === "unknown" ? 1 : 0;
    }
    await delay(1000);
  }
}
