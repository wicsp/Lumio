import { expect, test } from "bun:test";
import { createClient } from "../src/index.ts";
import { ExecutionTarget, Proposal } from "@lumio/schema";
const id = "prop_00000000000000000000000001";
const proposal = Proposal.parse({ id, operation: { op: "task.dispatch", args: { task: "task_00000000000000000000000001", trigger: "cli" } }, reason: "Synthetic", author: "act_00000000000000000000000001", status: "withdrawn", created: "2026-11-05T00:00:00Z" });
test("target and withdrawal methods validate their inputs, endpoints, responses and offline notes", async () => {
  const seen: string[] = [], warnings: string[][] = [];
  const target = ExecutionTarget.parse({ target: "codex@mac", runtime: "mac", engine: "codex", version: "synthetic", online: false });
  const client = createClient({ url: "http://localhost", onOfflineTargets: targets => warnings.push(targets), fetch: (async (url: URL, init: RequestInit) => {
    seen.push(`${init.method} ${url.pathname}${url.search}`);
    return url.pathname.includes("withdraw") ? Response.json(proposal) : Response.json([target], { headers: { "X-Lumio-Offline-Targets": target.target } });
  }) as unknown as typeof fetch });
  expect(await client.targets({ online: true })).toEqual([target]); expect(await client.withdrawProposal(id)).toEqual(proposal);
  expect(seen).toEqual(["GET /v2/execution/targets?online=true", `POST /v2/approval/proposals/${id}/withdraw`]); expect(warnings).toEqual([[target.target]]);
  expect(() => client.withdrawProposal("bad")).toThrow();
  const malformed = createClient({ url: "http://localhost", fetch: (async () => Response.json([{ ...target, secret: "synthetic" }])) as unknown as typeof fetch });
  await expect(malformed.targets()).rejects.toMatchObject({ code: "INTERNAL", status: 200 });
});
test("transport diagnostics retain only the Hub origin, never credentials, query, token or raw fetch errors", async () => {
  const client = createClient({ url: "http://user:synthetic-password@localhost:7420/private?synthetic-query", token: "synthetic-token", fetch: (async () => { throw Error("synthetic-private-fetch-detail"); }) as unknown as typeof fetch });
  try { await client.targets(); throw Error("expected failure"); } catch (error) {
    expect(error).toMatchObject({ code: "INTERNAL", hubUrl: "http://localhost:7420" });
    for (const secret of ["synthetic-password", "synthetic-query", "synthetic-token", "synthetic-private-fetch-detail"]) expect(JSON.stringify(error)).not.toContain(secret);
  }
});
