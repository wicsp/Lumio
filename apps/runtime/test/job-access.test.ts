import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobAccess, JobSpec } from "@lumio/schema";
import { Queue } from "../src/queue.ts";
import { CredentialRedactor } from "../src/redact.ts";
import { ADAPTERS } from "../src/agents.ts";

const spec = JobSpec.parse({ protocol_version: 2, id: "job_00000000000000000000000001", runtime: "act_00000000000000000000000001", lease: "synthetic-access-lease", run: { kind: "agent", engine: "pi", prompt: "Synthetic prompt" }, workdir: "~", timeout_seconds: 120, created: "2026-11-04T00:00:00Z" });
const access = JobAccess.parse({ job: spec.id, actor: spec.runtime, token: "lumio_" + "synthetic".repeat(6), expires: "2026-11-04T01:00:00Z" });

test("private queue persists access separately, rotates redelivery, and erases it on finish/recovery", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lumio-queue-access-")); let queue = new Queue(temp);
  try {
    queue.receive([spec], [access]); queue.close(); queue = new Queue(temp);
    expect(queue.access(spec.id)).toEqual(access); expect(JSON.stringify(queue.jobs())).not.toContain(access.token);
    expect((await stat(join(temp, "runtime.sqlite"))).mode & 0o777).toBe(0o600);
    const rotated = { ...access, token: access.token + "-rotated" };
    queue.receive([spec], [rotated]); expect(queue.access(spec.id)).toEqual(rotated);
    queue.ack([spec.id]); queue.start(spec.id, spec.created);
    queue.receive([spec], [access]); expect(queue.access(spec.id)).toEqual(rotated);
    queue.finish({ job: spec.id, lease: spec.lease, status: "unknown", finished: spec.created });
    expect(queue.access(spec.id)).toBeUndefined(); expect(JSON.stringify(queue.outbox())).not.toContain(rotated.token);
    expect(() => queue.receive([], [access])).toThrow();
    const routine = { ...spec, id: "job_00000000000000000000000002", source: { routine: "rtn_00000000000000000000000001", round: 1 } };
    queue.receive([routine]); expect(queue.access(routine.id)).toBeUndefined();
    const command = { ...spec, id: "job_00000000000000000000000003", run: { kind: "command" as const, argv: ["/bin/true"] } };
    expect(() => queue.receive([command], [{ ...access, job: command.id }])).toThrow();
  } finally { queue.close(); await rm(temp, { recursive: true, force: true }); }
});

test("redaction preserves arbitrary bytes and removes credentials at every chunk boundary", () => {
  const token = access.token, raw = Buffer.concat([Buffer.from([255, 0, 128]), Buffer.from(`before${token}middle${token}after`)]);
  for (let split = 1; split < raw.length; split++) {
    const redact = new CredentialRedactor([token]), result = Buffer.concat([redact.push(raw.subarray(0, split)), redact.push(raw.subarray(split)), redact.push(Buffer.alloc(0), true)]);
    expect(result).toEqual(Buffer.concat([Buffer.from([255, 0, 128]), Buffer.from("before[REDACTED]middle[REDACTED]after")]));
  }
});

test("each adapter supplies the round skill through its supported configuration", () => {
  const ctx = { lastMessageFile: "/synthetic/last.txt", skillFile: "/synthetic/skills/lumio/SKILL.md", skillText: "Synthetic skill instructions" };
  for (const engine of ["codex", "claude-code", "pi"] as const) {
    const argv = ADAPTERS[engine].argv({ kind: "agent", engine, prompt: "Synthetic prompt" }, ctx);
    expect(argv.join(" ")).not.toContain(access.token);
    if (engine === "codex") { expect(argv).toContain('developer_instructions="Synthetic skill instructions"'); expect(argv).toContain("shell_environment_policy.ignore_default_excludes=true"); }
    else if (engine === "claude-code") expect(argv).toContain("--append-system-prompt");
    else { expect(argv).toContain("--skill"); expect(argv).toContain(ctx.skillFile); }
  }
});
