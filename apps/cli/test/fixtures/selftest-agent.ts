// Synthetic executable for all three real runtime adapters. Never contacts an AI service.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const engine = process.argv[2]!, args = process.argv.slice(3);
if (args[0] === "--version") { console.log(engine === "codex" ? "codex-cli 0.163.0" : engine === "claude" ? "2.0.0 (Claude Code)" : "1.4.0"); process.exit(0); }
const value = (flag: string) => args[args.indexOf(flag) + 1]!;
const prompt = engine === "codex" ? args.at(-1)! : value("-p");
const session = engine === "codex" ? (args[1] === "resume" ? args.at(-2)! : crypto.randomUUID()) : args.includes("--resume") ? value("--resume") : args.includes("--session-id") ? value("--session-id") : crypto.randomUUID();
const file = join(process.env.FAKE_SESSIONS!, session);
let mode = ""; try { mode = readFileSync(process.env.FAKE_MODE_FILE!, "utf8"); } catch { /* normal */ }
let report = "OK";
if (prompt.includes("记住暗号")) { writeFileSync(file, /记住暗号 ([^，]+)/.exec(prompt)![1]!); }
else if (prompt.includes("暗号是什么")) { report = mode === "forget" ? "不记得" : readFileSync(file, "utf8"); }
else if (prompt.includes("问我一个问题")) { report = mode === "no-question" ? "OK" : "<lumio-question>准备好了吗？</lumio-question>"; }
else if (prompt.includes("等待 120 秒")) {
  if (mode === "no-cancel") { await Bun.sleep(250); report = "未取消便结束"; }
  else { setTimeout(() => console.log("OK"), 120_000); await new Promise(() => {}); }
}
if (engine === "codex") { writeFileSync(value("--output-last-message"), report); console.log(JSON.stringify({ type: "thread.started", thread_id: session })); }
else if (engine === "claude") console.log(JSON.stringify({ type: "result", result: report, session_id: session }));
else console.log(report);
