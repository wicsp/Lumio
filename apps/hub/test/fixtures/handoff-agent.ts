// Synthetic engines for R4-3. State and prompts stay in the temporary test directory.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [engine, ...args] = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(engine === "codex" ? "codex-cli 0.163.0" : "2.1.310 (Claude Code)");
  process.exit(0);
}
const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const prompt = engine === "codex" ? args.at(-1)! : value("-p")!;
const stage = /^## Plan stage: ([a-z0-9-]+)$/m.exec(prompt)?.[1];
const log = process.env.SYNTHETIC_AGENT_LOG!;
appendFileSync(log, JSON.stringify({ engine, stage, prompt }) + "\n");
const counter = process.env.SYNTHETIC_REVIEW_COUNT!;
let report = `Synthetic ${stage} delivered`;
if (stage === "review") {
  const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(count + 1));
  if (!count) report = "Fix the synthetic edge case.\n<lumio-outcome>changes</lumio-outcome>";
}
if (stage === "question") report = "<lumio-question>Which synthetic option?</lumio-question>";
if (stage === "loop") report = "<lumio-outcome>changes</lumio-outcome>";
if (engine === "codex") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "synthetic-handoff-session" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
  writeFileSync(value("--output-last-message")!, report);
} else console.log(JSON.stringify({ type: "result", result: report, session_id: value("--resume") ?? value("--session-id") ?? "synthetic-review-session" }));
if (stage === "failure") process.exit(3);
