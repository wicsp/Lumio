import { Database } from "bun:sqlite";
import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeQuotaBinding, ClaudeQuotaBindings, ClaudeQuotaSample, type AIQuotaWindow } from "@lumio/schema";
import type { RuntimeConfig } from "./config.ts";
import { quotaReset } from "./native/quota.ts";

function directory(state: string): string { return join(state, "claude-usage"); }
function filename(state: string): string { return join(directory(state), "samples.sqlite"); }

export function claudeWindows(input: unknown): AIQuotaWindow[] {
  const data = input as { rate_limits?: Record<string, { used_percentage?: unknown; resets_at?: unknown }> };
  return ([
    ["five_hour", 5 * 60],
    ["seven_day", 7 * 24 * 60],
  ] as const).flatMap(([id, minutes]) => {
    const raw = data?.rate_limits?.[id];
    if (typeof raw?.used_percentage !== "number" || !Number.isFinite(raw.used_percentage) ||
        raw.used_percentage < 0 || raw.used_percentage > 100) return [];
    return [{ id, minutes, used_percent: raw.used_percentage, resets_at: quotaReset(raw.resets_at) }];
  });
}

export async function storeClaudeUsage(state: string, binding: ClaudeQuotaBinding, input: unknown, now = new Date()) {
  const windows = claudeWindows(input).filter(window => !window.resets_at || Date.parse(window.resets_at) > now.getTime());
  if (!windows.length) return false;
  const sample = ClaudeQuotaSample.parse({ ...binding, sampled_at: now.toISOString(), windows });
  await mkdir(directory(state), { recursive: true, mode: 0o700 });
  await chmod(directory(state), 0o700);
  const file = filename(state);
  const db = new Database(file, { create: true });
  try {
    await chmod(file, 0o600);
    db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS samples(connection TEXT NOT NULL, generation TEXT NOT NULL, at TEXT NOT NULL,
        windows TEXT NOT NULL, PRIMARY KEY(connection,generation));`);
    const changed = db.query(`INSERT INTO samples VALUES(?,?,?,?)
      ON CONFLICT(connection,generation) DO UPDATE SET at=excluded.at,windows=excluded.windows
      WHERE samples.at < excluded.at AND samples.windows <> excluded.windows`)
      .run(sample.connection, sample.generation, sample.sampled_at, JSON.stringify(sample.windows));
    return changed.changes > 0;
  } finally { db.close(); }
}

export async function sampleClaudeFromStdin(args: string[], input = process.stdin): Promise<void> {
  const [connection, generation, option, path, ...extra] = args;
  if (extra.length || (args.length !== 2 && (option !== "--state-dir" || !path))) throw new Error();
  const binding = ClaudeQuotaBinding.parse({ connection, generation });
  const state = resolve(path ?? process.env.LUMIO_RUNTIME_STATE_DIR ?? join(homedir(), ".local", "share", "lumio-runtime"));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, json = "";
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > 262_144) throw new Error();
    json += decoder.decode(chunk, { stream: true });
  }
  await storeClaudeUsage(state, binding, JSON.parse(json + decoder.decode()));
}

/** Negotiate support before sending anything. The Runtime token stays in the daemon. */
export async function publishClaudeUsage(config: RuntimeConfig, fetcher: typeof fetch, signal: AbortSignal, sentAt: Map<string, string>): Promise<void> {
  const file = filename(config.stateDir);
  if (!(await stat(file).catch(() => undefined))?.isFile()) return;
  const url = `${config.url}/v2/runtime/claude-usage`;
  const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  const request = (method: "GET" | "POST", body?: string) => fetcher(url, {
    method, headers, body, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  const response = await request("GET");
  if (!response.ok) { void response.body?.cancel().catch(() => {}); return; }
  const bindings = ClaudeQuotaBindings.parse(await response.json());
  const current = new Set(bindings.map(binding => binding.generation));
  for (const generation of sentAt.keys()) if (!current.has(generation)) sentAt.delete(generation);
  const db = new Database(file, { readonly: true });
  let samples: ClaudeQuotaSample[];
  try {
    const get = db.query<{ at: string; windows: string }, [string, string]>("SELECT at,windows FROM samples WHERE connection=? AND generation=?");
    samples = bindings.flatMap(binding => {
      const row = get.get(binding.connection, binding.generation);
      return row && sentAt.get(binding.generation) !== row.at
        ? [ClaudeQuotaSample.parse({ ...binding, sampled_at: row.at, windows: JSON.parse(row.windows) })] : [];
    });
  } finally { db.close(); }
  for (const sample of samples) {
    if (signal.aborted) return;
    const sent = await request("POST", JSON.stringify(sample));
    if (sent.status === 204) sentAt.set(sample.generation, sample.sampled_at);
    void sent.body?.cancel().catch(() => {});
  }
}
