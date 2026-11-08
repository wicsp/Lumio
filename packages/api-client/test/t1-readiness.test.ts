import { expect, test } from "bun:test";
import { createClient } from "../src/index.ts";

test("Work list forwards every combined filter and rejects invalid readiness inputs before HTTP", async () => {
  const seed = await Bun.file(new URL("../../../fixtures/work/readiness.json", import.meta.url)).json();
  const calls: URL[] = [];
  const fetcher = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    calls.push(new URL(String(input)));
    return Response.json([{ ...seed, blocked_by: [] }]);
  }, { preconnect: fetch.preconnect });
  const client = createClient({ url: "https://synthetic.invalid", fetch: fetcher });
  expect(await client.workTasks({ readiness: "ready", tag: "infra & research", parent: seed.id, project: seed.id.replace("task_", "prj_"), query: "Synthetic", status: "todo" })).toMatchObject([{ blocked_by: [] }]);
  expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ readiness: "ready", tag: "infra & research", parent: seed.id, project: seed.id.replace("task_", "prj_"), q: "Synthetic", status: "todo" });
  expect(() => client.workTasks({ tag: "" })).toThrow();
  expect(() => client.workTasks({ parent: "invalid" })).toThrow();
  expect(calls).toHaveLength(1);
});
