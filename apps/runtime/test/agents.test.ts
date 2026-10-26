import { parseArgs } from "node:util";
import { expect, test } from "bun:test";
import { AgentRun } from "@lumio/schema";
import { ADAPTERS, compareVersions, splitQuestion, versionSupported } from "../src/agents.ts";

const ctx = { lastMessageFile: "/state/logs/job.last.txt" };
const run = (fields: object = {}) => AgentRun.parse({ kind: "agent", engine: "codex", prompt: "做事", ...fields });

test("codex: workspace-write sandbox, JSON events, last message file; resume uses exec resume", () => {
  expect(ADAPTERS.codex.argv(run({ model: "m1" }), ctx)).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--json",
    "--output-last-message", ctx.lastMessageFile, "-m", "m1", "做事"]);
  expect(ADAPTERS.codex.argv(run({ session: { id: "thr-1", resume: true } }), ctx).slice(0, 2)).toEqual(["exec", "resume"]);
  expect(ADAPTERS.codex.argv(run({ session: { id: "thr-1", resume: true } }), ctx).slice(-2)).toEqual(["thr-1", "做事"]);
  const parsed = ADAPTERS.codex.parse('noise\n{"type":"thread.started","thread_id":"thr-9"}\n{"type":"turn.completed"}\n', " 汇报 \n", run());
  expect(parsed).toEqual({ report: "汇报", sessionId: "thr-9" });
  expect(ADAPTERS.codex.sandbox).toBe("os");
});

test("claude: print mode with JSON output and no interactive permission prompts; new vs resume session", () => {
  const c = (fields: object) => ADAPTERS["claude-code"].argv(run({ engine: "claude-code", ...fields }), ctx);
  expect(c({})).toEqual(["-p", "做事", "--output-format", "json", "--permission-mode", "bypassPermissions"]);
  expect(c({ session: { id: "u-1", resume: false } }).slice(-2)).toEqual(["--session-id", "u-1"]);
  expect(c({ session: { id: "u-1", resume: true } }).slice(-2)).toEqual(["--resume", "u-1"]);
  expect(ADAPTERS["claude-code"].parse('log line\n{"type":"result","result":"好了","session_id":"u-2"}\n', undefined, run()))
    .toEqual({ report: "好了", sessionId: "u-2" });
  expect(ADAPTERS["claude-code"].parse("not json", undefined, run())).toEqual({});
  expect(ADAPTERS["claude-code"].sandbox).toBe("none");
});

test("pi: one --session-id for both new and continued sessions; stdout is the report", () => {
  const r = run({ engine: "pi", model: "x", session: { id: "task_1", resume: true } });
  expect(ADAPTERS.pi.argv(r, ctx)).toEqual(["-p", "做事", "--model", "x", "--session-id", "task_1"]);
  expect(ADAPTERS.pi.parse(" 结果\n", undefined, r)).toEqual({ report: "结果", sessionId: "task_1" });
});

test("versions outside the verified range are rejected", () => {
  expect(compareVersions("0.163.0", "0.160.0")).toBe(1);
  expect(compareVersions("1.4.0-beta.1", "1.4.0")).toBe(0);
  expect(versionSupported(ADAPTERS.codex, "0.163.0")).toBe(true);
  expect(versionSupported(ADAPTERS.codex, "0.200.0")).toBe(false);
  expect(versionSupported(ADAPTERS.pi, "1.3.9")).toBe(false);
  expect(versionSupported(ADAPTERS["claude-code"], "2.1.310")).toBe(true);
});

test("question marker becomes a separate question; empty marker is ignored", () => {
  expect(splitQuestion("做了 A。\n<lumio-question> 要不要顺手重构？ </lumio-question>")).toEqual({ report: "做了 A。", question: "要不要顺手重构？" });
  expect(splitQuestion("没有问题")).toEqual({ report: "没有问题" });
  expect(splitQuestion("x <lumio-question> </lumio-question>")).toEqual({ report: "x" });
});


test("Codex resumed rounds use the resume parser's supported flags and preserve workspace isolation", () => {
  const argv = ADAPTERS.codex.argv(run({ model: "m1", session: { id: "thread-previous", resume: true } }), ctx);
  // Codex 0.163.0 exec resume --help：子命令有 --config/-c，没有 --sandbox。
  // 用严格子命令语法校验，旧实现会因 unknown --sandbox 直接失败。
  const parsed = parseArgs({ args: argv.slice(2), allowPositionals: true, strict: true, options: {
    "skip-git-repo-check": { type: "boolean" }, config: { type: "string", short: "c" }, json: { type: "boolean" },
    "output-last-message": { type: "string" }, model: { type: "string", short: "m" },
  } });
  expect(parsed.values.config).toBe('sandbox_mode="workspace-write"');
  expect(parsed.values.json).toBe(true); expect(parsed.values["output-last-message"]).toBe(ctx.lastMessageFile);
  expect(parsed.positionals).toEqual(["thread-previous", "做事"]);
});
