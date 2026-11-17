import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { writeFileSync } from "node:fs";

const engine = basename(process.argv[1]!).includes("claude") ? "claude-code" : "codex";
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const arg = (...keys: string[]) => keys.some(key => process.argv.includes(key));
if (arg("--version", "-V")) {
  console.log(engine === "codex" ? "codex-cli 0.166.0" : "2.1.322 (Claude Code)");
  process.exit(0);
}
if (engine === "codex" && arg("exec")) {
  send({ type: "thread.started", thread_id: "fixture-thread" });
  send({ type: "turn.started" });
  const item = { type: "command_execution", id: "command", command: "bun test --TOKEN=fixture_only", status: "in_progress" };
  send({ type: "item.started", item });
  await Bun.sleep(2400);
  send({ type: "item.completed", item: { ...item, status: "completed", aggregated_output: "fixture_only" } });
  const i = process.argv.indexOf("--output-last-message");
  writeFileSync(process.argv[i + 1]!, "Report from the synthetic Codex");
  send({ type: "turn.completed", usage: {} });
  process.exit(0);
}

const input = createInterface({ input: process.stdin });
const thread = "thread-fixture", turn = "turn-fixture";
const session = "b6043e5a-902c-4192-92b2-bd0e4d2d9410";
const message = (content: unknown[], type = "assistant") => ({
  type, session_id: session, uuid: randomUUID(), parent_tool_use_id: null,
  message: { id: "msg_fixture", type: "message", model: "fixture", role: type === "assistant" ? "assistant" : "user",
    content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
});
const notify = (method: string, params: Record<string, unknown>) => send({ method, params });
const resolved = (requestId: string) => notify("serverRequest/resolved", { threadId: thread, requestId });
const request = (id: string, method: string, params: Record<string, unknown>) => send({ id, method, params: { threadId: thread, turnId: turn, ...params } });
const questions = [{ id: "question", question: "Use the small fixture?", header: "Fixture", options: [{ label: "Yes", description: "Small" }] }];
let decision = "", answer = "";
for await (const line of input) {
  let data: any;
  try { data = JSON.parse(line); } catch { continue; }
  if (engine === "codex") {
    const reply = (result: Record<string, unknown>) => send({ id: data.id, result });
    switch (data.method) {
      case "initialize": reply({ userAgent: "fixture" }); break;
      case "account/login/start": reply({ type: "apiKey" }); break;
      case "account/read": reply({ account: { type: "apiKey" } }); break;
      case "thread/start":
      case "thread/resume": reply({ thread: { id: thread }, approvalPolicy: "on-request", approvalsReviewer: "user" }); break;
      case "turn/start":
        reply({ turn: { id: turn, status: "inProgress" } });
        notify("turn/started", { threadId: thread, turn: { id: turn } });
        request("question-request", "item/tool/requestUserInput", { itemId: "question", questions });
        break;
      case "turn/steer": reply({ turnId: turn }); break;
      case "turn/interrupt": reply({}); notify("turn/completed", { threadId: thread, turn: { id: turn, status: "interrupted" } }); break;
    }
    if (data.id === "question-request") {
      answer = data.result?.answers?.question?.answers?.[0] ?? "";
      resolved(data.id);
      request("approval-request", "item/commandExecution/requestApproval", { itemId: "allow-test", command: "bun test", cwd: process.cwd(), availableDecisions: ["accept", "decline"] });
    }
    if (data.id === "approval-request") {
      decision = data.result?.decision ?? "";
      resolved(data.id);
      notify("item/completed", { threadId: thread, turnId: turn, item: { type: "agentMessage", text: `Fixture answer=${answer} decision=${decision}` } });
      notify("turn/completed", { threadId: thread, turn: { id: turn, status: "completed" } });
    }
    continue;
  }
  const sdkReply = (id: string, response: Record<string, unknown>) =>
    send({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  const use = (id: string, tool_name: string, args: Record<string, unknown>) => {
    send(message([{ type: "tool_use", id, name: tool_name, input: args }]));
    send({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name, input: args, tool_use_id: id } });
  };
  if (data.type === "control_request") {
    sdkReply(data.request_id, { commands: [], models: [], account: {}, output_style: "default", available_output_styles: [] });
  }
  if (data.type === "user") {
    send({ type: "system", subtype: "init", session_id: session, uuid: randomUUID(), cwd: process.cwd(), tools: [], mcp_servers: [], model: "fixture", permissionMode: "default", slash_commands: [], apiKeySource: "none", output_style: "default" });
    use("question-request", "AskUserQuestion", { questions });
  }
  if (data.type !== "control_response") continue;
  if (data.response.request_id === "question-request") {
    answer = data.response?.response?.updatedInput?.answers?.["Use the small fixture?"] ?? "";
    send(message([{ type: "tool_result", tool_use_id: "question-request", content: "question processed" }], "user"));
    use("approval-request", "Bash", { command: "bun test" });
  }
  if (data.response.request_id === "approval-request") {
    decision = data.response?.response?.behavior ?? "";
    send(message([{ type: "tool_result", tool_use_id: "approval-request", content: "approval processed" }], "user"));
    send({ type: "result", subtype: "success", result: `Fixture answer=${answer} decision=${decision}`, duration_ms: 123, duration_api_ms: 10,
      is_error: false, num_turns: 2, session_id: session, uuid: randomUUID(), total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
  }
}
