/** Synthetic official-protocol fixture. No model, credentials, or business data. */
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CAPABILITIES, toolName } from "../../packages/schema/src/index.ts";
const home = process.env.CODEX_HOME!;
await mkdir(home, { recursive: true });
const path = join(home, "fixture-state.json");
let saved: Record<string, any>;
try {
    saved = JSON.parse(await readFile(path, "utf8"));
}
catch {
    saved = { calls: 0, thread: "fixture-thread", recall: "SYNTHETIC" };
}
let pending: {
    turn: string;
    text: string;
} | undefined;
let serial = 0;
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method: string, params: unknown) => send({ method, params });
const policy = { model: "gpt-6.1-sol", reasoningEffort: "low", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
async function finish(turn: string, content: string, status = "completed") {
    notify("item/agentMessage/delta", { threadId: saved.thread, turnId: turn, delta: content });
    notify("turn/completed", { threadId: saved.thread, turn: { id: turn, status, error: null } });
    await writeFile(path, JSON.stringify(saved));
}
createInterface({ input: process.stdin }).on("line", line => {
    void (async () => {
        const m = JSON.parse(line);
        if (!m.method) {
            if (pending && m.id === "fixture-approval") {
                const p = pending;
                pending = undefined;
                if (m.result?.decision === "accept") {
                    saved.approvals = (saved.approvals ?? 0) + 1;
                    await writeFile(join(home, "approved-marker"), "SYNTHETIC");
                }
                await finish(p.turn, "APPROVAL_FINISHED");
            }
            return;
        }
        if (m.id === undefined)
            return;
        const reply = (result: unknown) => send({ id: m.id, result });
        const p = m.params ?? {};
        switch (m.method) {
            case "initialize":
                reply({ userAgent: "synthetic" });
                break;
            case "account/read":
                reply({ account: { type: "chatgpt", accountId: "synthetic-account" }, requiresOpenaiAuth: true });
                break;
            case "config/read":
                reply({});
                break;
            case "model/list":
                reply({ data: ["gpt-6.1-sol", "gpt-6.1-terra"].map(id => ({ id, model: id, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort })) })), nextCursor: null });
                break;
            case "thread/start":
            case "thread/resume":
                reply({ ...policy, thread: { id: saved.thread, status: { type: "idle" } } });
                break;
            case "mcpServerStatus/list":
                reply({ data: [{ name: "lumio", tools: Object.fromEntries(CAPABILITIES.map(c => [toolName(c.name), {}])) }], nextCursor: null });
                break;
            case "thread/turns/list":
                reply({ data: [], nextCursor: null });
                break;
            case "thread/compact/start":
                reply({});
                notify("item/completed", { item: { id: "compact", type: "contextCompaction" } });
                break;
            case "turn/interrupt":
                reply({});
                if (pending) {
                    const q = pending;
                    pending = undefined;
                    await finish(q.turn, "", "interrupted");
                }
                break;
            case "turn/start": {
                const input = p.input[0].text as string;
                const turn = `fixture-turn-${++serial}`;
                saved.calls++;
                await writeFile(path, JSON.stringify(saved));
                if (input.includes("NO_ACK")) {
                    process.exit(9);
                }
                reply({ turn: { id: turn, status: "inProgress" } });
                notify("thread/settings/updated", { threadId: saved.thread, threadSettings: { ...policy, cwd: p.cwd, sandboxPolicy: p.sandboxPolicy, model: p.model, effort: p.effort } });
                notify("turn/started", { turn: { id: turn } });
                if (input.includes("APPROVE")) {
                    pending = { turn, text: input };
                    notify("item/started", { item: { id: "command-1", type: "commandExecution", command: "synthetic marker" } });
                    send({ id: "fixture-approval", method: "item/commandExecution/requestApproval", params: { threadId: saved.thread, turnId: turn, itemId: "command-1", command: "write synthetic marker", reason: "Synthetic approval test" } });
                    break;
                }
                if (input.includes("WAIT")) {
                    pending = { turn, text: input };
                    break;
                }
                const remember = /REMEMBER ([A-Z_]+)/.exec(input);
                if (remember)
                    saved.recall = remember[1];
                notify("item/reasoning/summaryTextDelta", { delta: "Synthetic public summary." });
                await finish(turn, input.includes("RECALL") ? saved.recall : "SYNTHETIC_OK");
                break;
            }
            default: reply({});
        }
    })();
});
