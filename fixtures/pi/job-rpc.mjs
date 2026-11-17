#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) { console.log("1.5.0"); process.exit(0); }
const args = process.argv.slice(2);
const flag = key => args[args.indexOf(key) + 1];
const sessionId = flag("--session-id");
const history = join(flag("--session-dir"), `${sessionId}.jsonl`);
const prior = existsSync(history);
const send = record => process.stdout.write(JSON.stringify(record) + "\n");
const approvalId = "00000000-0000-4000-8000-000000000001";
const questionId = "00000000-0000-4000-8000-000000000002";
const source = "lumio-job";
const ui = (id, method, title, fields) => send({ type: "extension_ui_request", id, method, title: JSON.stringify({ source, ...title }), ...fields });
const applied = (id, action) => {
  send({ type: "extension_ui_request", id: `applied-${id}`, method: "notify", message: JSON.stringify({ source, id, applied: action }) });
};
const settle = (text, aborted = false) => {
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  send({ type: "agent_settled", aborted });
};
let answer = "", prompt = "";
for await (const line of createInterface({ input: process.stdin })) {
  const data = JSON.parse(line);
  const response = value => send({ type: "response", command: data.type, success: true, id: data.id, data: value });
  switch (data.type) {
    case "get_state": response({ sessionId }); break;
    case "get_commands": response({ commands: [{ name: "lumio-job-ready", source: "extension" }] }); break;
    case "prompt":
      prompt = data.message;
      writeFileSync(history, "fixture history\n");
      response({});
      send({ type: "agent_start" });
      send({ type: "tool_execution_start", toolCallId: "ask-tool", toolName: "lumio_ask_user", args: { question: "Pick a color" } });
      ui("question", "select", { id: questionId, kind: "question", text: "Pick a color" }, { options: ["Red", "Blue"], timeout: 30_000 });
      break;
    case "extension_ui_response":
      if (data.id === "question" && data.value) {
        answer = data.value;
        applied(questionId, "answer");
        send({ type: "tool_execution_end", toolCallId: "ask-tool", toolName: "lumio_ask_user", isError: false });
        send({ type: "tool_execution_start", toolCallId: "write-tool", toolName: "write", args: { path: "approved.txt" } });
        ui("approval", "confirm", { id: approvalId, kind: "approval", tool: "write" }, { message: "approved.txt", timeout: prompt === "expire" ? 200 : 30_000 });
      } else if (data.id === "approval") {
        if (data.confirmed === true) {
          writeFileSync("approved.txt", answer);
          applied(approvalId, "approve");
        } else if (data.confirmed === false) applied(approvalId, "deny");
        send({ type: "tool_execution_end", toolCallId: "write-tool", toolName: "write", isError: data.confirmed !== true,
          result: { content: process.env.OPENAI_API_KEY } });
        settle(`${answer} ${data.confirmed === true ? "approved" : "declined"} ${prior ? "continued" : "new"}`);
      }
      break;
    case "abort": response({}); settle("cancelled", true); break;
  }
}
