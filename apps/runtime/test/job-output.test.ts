import { expect, test } from "bun:test";
import { JobActivityEvent } from "@lumio/schema";
import { JobOutput } from "../src/job-output.ts";

test("Codex activity ignores arbitrary output and exposes a bounded command and project file labels", () => {
  const seen: JobActivityEvent[] = [];
  const output = new JobOutput("codex", "/project", event => seen.push(JobActivityEvent.parse({ ...event, at: new Date().toISOString() })));
  const payload = [
    "{bad JSON",
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "unrecognized", addition: "secret" }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", id: "cmd", command: "bun test --flag=hidden-value", aggregated_output: "secret" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", id: "cmd", status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { type: "file_change", id: "edit", changes: [{ path: "/project/src/代码.ts" }, { path: "/outside/private" }] } }),
  ].join("\n");
  const bytes = Buffer.from(payload);
  for (let i = 0; i < bytes.length; i += 5) output.push(bytes.subarray(i, i + 5));
  output.push(Buffer.alloc(0), true);
  expect(output.sessionId).toBe("thread-1");
  expect(seen.map(event => event.type)).toEqual(["tool_started", "tool_finished", "tool_started", "tool_finished"]);
  expect(seen.at(0)).toMatchObject({ tool: { label: "bun test" } });
  expect(seen.at(-1)).toMatchObject({ tool: { files: ["src/代码.ts"] } });
  expect(JSON.stringify(seen)).not.toMatch(/secret|hidden-value|outside/);
});

test("Claude keeps the final result after malformed and oversized lines", () => {
  const events: string[] = [];
  const output = new JobOutput("claude-code", "/project", event => events.push(event.type));
  output.push(Buffer.from("x".repeat(4 * 1024 * 1024 + 1)));
  const items = [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "bash-1", input: { command: "git status" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "ignored" }] } },
    { type: "result", result: "检查通过", session_id: "session-1" },
  ];
  const body = Buffer.from("\n" + items.map(item => JSON.stringify(item)).join("\n"));
  const split = body.length - 49;
  output.push(body.subarray(0, split));
  output.push(body.subarray(split), true);
  expect(events).toEqual(["tool_started", "tool_finished"]);
  expect(output.report).toBe("检查通过");
  expect(output.sessionId).toBe("session-1");
});
