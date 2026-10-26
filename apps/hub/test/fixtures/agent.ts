// 假的 codex / claude / pi，只用于 P2-3 的测试：模拟各自的参数与输出格式，并把收到的参数记下来。
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [engine, ...args] = process.argv.slice(2);
const versions: Record<string, string> = { codex: "codex-cli 0.163.0", claude: "2.1.310 (Claude Code)", pi: "1.4.0" };
if (args[0] === "--version") { console.log(process.env[`FAKE_${engine!.toUpperCase()}_VERSION`] ?? versions[engine!]); process.exit(0); }
const stdin = await new Response(Bun.stdin.stream()).text();
const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const prompt = engine === "codex" ? args.at(-1)! : value("-p")!;
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ engine, args, stdin, cwd: process.cwd() }) + "\n");
if (prompt.includes("SLEEP")) await Bun.sleep(60_000);
if (prompt.includes("COMMIT")) {
  writeFileSync(join(process.cwd(), "made-by-agent.txt"), "hello\n");
  for (const a of [["add", "made-by-agent.txt"], ["-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "commit", "-qm", "agent"]]) {
    Bun.spawnSync(["git", ...a], { stdout: "ignore", stderr: "ignore" });
  }
}
const reply = `完成：${prompt}` + (prompt.includes("ASK") ? "\n<lumio-question>要不要顺手重构？</lumio-question>" : "");
if (engine === "codex") {
  const resumed = args[1] === "resume" ? args.at(-2) : undefined;
  console.log(JSON.stringify({ type: "thread.started", thread_id: resumed ?? "thr-fake-1" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
  writeFileSync(value("--output-last-message")!, reply);
} else if (engine === "claude") {
  console.log(JSON.stringify({ type: "result", result: reply, session_id: value("--resume") ?? value("--session-id") ?? "sess-claude-1" }));
} else {
  console.log(reply);
}
console.error("agent stderr");
if (prompt.includes("FAIL")) process.exit(3);
