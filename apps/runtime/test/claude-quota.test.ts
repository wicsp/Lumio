import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeRuntimeCommand, NativeRuntimeMessage } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { runNativeChannel } from "../src/native/channel.ts";
import { parseClaudeUsage, runClaudeQuotaTerminal } from "../src/native/claude-quota.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/ai-usage/fake-claude-quota.ts", import.meta.url));
const account = "a".repeat(64);

async function terminal(mode: string, known?: string, expected?: string) {
  const cwd = await mkdtemp(join(tmpdir(), "lumio-claude-quota-test-"));
  try {
    return await runClaudeQuotaTerminal([process.execPath, fixture, mode], cwd, { TERM: "xterm-256color" },
      new AbortController().signal, known, expected, 1800);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("verifies the account and reads only the built-in Claude quota screen in a short-lived terminal", async () => {
  const result = await terminal("ready");
  expect(result).toEqual({ status: "ready", account: expect.stringMatching(/^[0-9a-f]{64}$/),
    windows: [{ id: "five_hour", minutes: 300, used_percent: 32 }, { id: "seven_day", minutes: 10080, used_percent: 64 }] });
});

test("stops at trust, mismatched identity, rate limits and unknown command menus", async () => {
  expect(await terminal("trust")).toEqual({ status: "failed", issue: "trust_required" });
  expect(await terminal("ready", undefined, account)).toEqual({ status: "failed", issue: "account_changed" });
  expect(await terminal("limit", account)).toEqual({ status: "failed", issue: "rate_limited" });
  expect(await terminal("unknown", account)).toEqual({ status: "failed", issue: "unknown_layout" });
});

test("does not infer missing quota or ambiguous reset times from model-specific windows", () => {
  const now = new Date("2026-11-10T01:00:00Z");
  expect(parseClaudeUsage("Current session\n3% used\nResets 5:30am (Etc/UTC)\nCurrent week (Sonnet only)\n90% used", now))
    .toEqual([{ id: "five_hour", minutes: 300, used_percent: 3, resets_at: "2026-11-10T05:30:00.000Z" }]);
  expect(parseClaudeUsage("Current week (all models)\n24% used\nResets 3pm (PST)", now))
    .toEqual([{ id: "seven_day", minutes: 10080, used_percent: 24 }]);
  expect(parseClaudeUsage("Current week (all models)\n24% used\nResets an unknown day at 3pm (UTC)", now))
    .toEqual([{ id: "seven_day", minutes: 10080, used_percent: 24 }]);
});

test("keeps the date on a Claude weekly reset rendered with at", () => {
  const now = new Date("2026-11-11T16:04:00Z");
  const screen = [
    "Current session", "12% used", "Resets 5pm (UTC)",
    "Current week (all models)", "28% used", "Resets Nov 15 at 12pm (UTC)",
    "Current week (Fable)", "4% used", "Resets Nov 15 at 11:59am (UTC)",
  ].join("\n");
  expect(parseClaudeUsage(screen, now)).toEqual([
    { id: "five_hour", minutes: 300, used_percent: 12, resets_at: "2026-11-11T17:00:00.000Z" },
    { id: "seven_day", minutes: 10080, used_percent: 28, resets_at: "2026-11-15T12:00:00.000Z" },
  ]);
});

test("Claude quota capability requires the local Runtime operator to opt in", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lumio-claude-quota-opt-in-"));
  const allowed = "aic_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const foreign = NativeRuntimeCommand.parse({ type: "claude_usage", command: crypto.randomUUID(),
    connection: "aic_01ARZ3NDEKTSV4RRFFQ69G5FAW", generation: crypto.randomUUID() });
  try {
    for (const enabled of [false, true]) {
      const hello = Promise.withResolvers<NativeRuntimeMessage>();
      const reply = Promise.withResolvers<NativeRuntimeMessage>();
      const encoder = new TextEncoder();
      const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
          if (request.method === "GET") {
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode("\n"));
                if (enabled && process.platform === "darwin") controller.enqueue(encoder.encode(JSON.stringify(foreign) + "\n"));
              },
            });
            return new Response(stream, { headers: {
              "X-Lumio-Native-Channel": "fixture",
              "X-Lumio-Native-Claude-Usage": "1",
            } });
          }
          const message = NativeRuntimeMessage.parse(await request.json());
          if (message.type === "hello") hello.resolve(message);
          if (message.type === "claude_usage") reply.resolve(message);
          return new Response(null, { status: 204 });
        },
      });
      const controller = new AbortController();
      const env = { LUMIO_HUB_URL: server.url.href, LUMIO_TOKEN: "fixture",
        LUMIO_RUNTIME_NAME: "fixture-mac", LUMIO_RUNTIME_STATE_DIR: cwd, LUMIO_CLAUDE_QUOTA_CONNECTION: enabled ? allowed : undefined };
      const run = runNativeChannel(readConfig(env), controller.signal, env);
      try {
        const message = await Promise.race([hello.promise, Bun.sleep(3000).then(() => undefined)]);
        expect(message?.type).toBe("hello");
        if (message?.type === "hello") {
          expect(message.claude_usage).toBe(enabled && process.platform === "darwin" ? true : undefined);
        }
        if (enabled && process.platform === "darwin") {
          expect(await Promise.race([reply.promise, Bun.sleep(3000).then(() => undefined)]))
            .toMatchObject({ type: "claude_usage", result: { status: "failed", issue: "account_unverified" } });
        }
      } finally {
        controller.abort();
        await server.stop(true);
        await run;
      }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
