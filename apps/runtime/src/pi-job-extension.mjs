import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const timeout = 300_000;
const readTools = new Set(["read", "grep", "find", "ls", "lumio_ask_user"]);
const writeTools = new Set(["edit", "write"]);
const shellEnv = new Set(["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "TERM", "LUMIO_HUB_URL", "LUMIO_TOKEN", "CUDA_VISIBLE_DEVICES"]);
const block = { block: true, reason: "The Lumio job did not approve this tool call." };
const inside = (cwd, path) => {
  const diff = relative(cwd, resolve(cwd, path));
  return diff && !isAbsolute(diff) && diff !== ".." && !diff.startsWith("../");
};

export default function (pi) {
  const bash = createBashToolDefinition(process.cwd(), {
    exposeSessionEnvironment: false,
    spawnHook: ({ command, cwd, env }) => ({
      command, cwd, env: Object.fromEntries(Object.entries(env).filter(([key]) => shellEnv.has(key)
        || key.startsWith("LUMIO_SECRET_") || key.startsWith("LUMIO_SUDO_"))),
    }),
  });
  pi.registerTool(bash);
  pi.registerCommand("lumio-job-ready", { description: "Lumio tool policy loaded", handler: async () => {} });
  pi.on("tool_call", async (event, ctx) => {
    if (readTools.has(event.toolName)) return;
    const bash = event.toolName === "bash";
    const preview = bash ? event.input.command : event.input.path;
    if ((!bash && !writeTools.has(event.toolName)) || typeof preview !== "string" || !preview.trim()
      || (!bash && (process.env.LUMIO_PI_READ_ONLY === "1" || !inside(ctx.cwd, preview)))) return block;
    const id = randomUUID();
    const title = JSON.stringify({ source: "lumio-job", id, kind: "approval", tool: event.toolName });
    const approved = await ctx.ui.confirm(title, preview, { timeout });
    ctx.ui.notify(JSON.stringify({ source: "lumio-job", id, applied: approved ? "approve" : "deny" }), "info");
    return approved ? undefined : block;
  });
  pi.registerTool({
    name: "lumio_ask_user", label: "Ask user", description: "Pause this task to ask the user a question when their input is needed.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 2000 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 480 }), { minItems: 1, maxItems: 8, uniqueItems: true })) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const id = randomUUID();
      const title = JSON.stringify({ source: "lumio-job", id, kind: "question", text: params.question });
      const options = { timeout, signal };
      const value = params.options?.length ? await ctx.ui.select(title, params.options, options) : await ctx.ui.input(title, undefined, options);
      if (typeof value === "string") ctx.ui.notify(JSON.stringify({ source: "lumio-job", id, applied: "answer" }), "info");
      return { content: [{ type: "text", text: value ?? "No answer received." }], details: {} };
    },
  });
}
