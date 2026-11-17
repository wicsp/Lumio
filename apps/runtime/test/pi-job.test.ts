import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { JobAction, JobHumanRequest, JobSpec, type JobControlTarget } from "@lumio/schema";
import { jobEngineCapabilities, interactiveEngine } from "../src/job-engine-config.ts";

const source = new URL("../../../fixtures/pi/job-rpc.mjs", import.meta.url).pathname;
const runner = new URL("../src/main.ts", import.meta.url).pathname;
const skip = process.platform !== "darwin" || !Bun.which("node");

test.skipIf(skip)("Pi uses the existing job controls for tool events, questions, approval, decline and continuation", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "lumio-pi-job-"));
  const project = join(root, "work"), state = join(root, "runtime"), bin = join(root, "bin");
  try {
    await Promise.all([project, state, bin].map(path => mkdir(path)));
    const pi = join(bin, "pi.mjs");
    await cp(source, pi);
    await Bun.spawn(["/bin/chmod", "+x", pi]).exited;
    await Bun.spawn(["/bin/ln", "-s", pi, join(bin, "pi")]).exited;
    const env = { PATH: `${bin}:${dirname(Bun.which("node")!)}:/usr/bin:/bin`, LUMIO_INTERACTIVE_JOB_ROOTS: project,
      LUMIO_JOB_PI_MODEL: "openai/gpt-4o-mini", OPENAI_API_KEY: "fixture-secret-pi" };
    const registered = [{ name: "pi" as const, version: "1.5.0", sandbox: "none" as const }];
    expect(await jobEngineCapabilities(registered, { ...env, OPENAI_API_KEY: undefined })).toEqual([
      { engine: "pi", version: "1.5.0", progress: true, sandbox: "none", questions: false, approvals: false, steer: false },
    ]);
    expect(await jobEngineCapabilities(registered, env)).toEqual([
      { engine: "pi", version: "1.5.0", progress: true, sandbox: "os", questions: true, approvals: true, steer: false },
    ]);
    const provider = await interactiveEngine("pi", "1.5.0", env);
    if (!provider) throw new Error("Pi fixture capability unavailable");
    const execute = async (round: number, decision: "approve" | "deny" | "expire" | "stop") => {
      const id = `job_${round.toString().padStart(26, "0")}`, dir = join(state, id);
      await mkdir(dir);
      const spec = JobSpec.parse({ id, protocol_version: 2, runtime: "act_00000000000000000000000000", lease: "fixture-lease-123456789",
        created: new Date().toISOString(), timeout_seconds: 60, workdir: project, run: { kind: "agent", engine: "pi", interaction: "interactive",
          prompt: decision, session: { id: "test-session", resume: round > 1 } } });
      const completion = join(dir, "exit.json"), lastMessageFile = join(dir, "last-message");
      const child = spawn(process.execPath, [runner, "--job-worker"], { stdio: ["pipe", "pipe", "pipe", "ipc"], env: { PATH: "/usr/bin:/bin" } });
      const output = new Response(child.stdout as unknown as ReadableStream).text();
      const exited = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
      const requests: JobHumanRequest[] = [], applied: string[] = [];
      child.stderr?.resume();
      child.on("message", raw => {
        const value = raw as { kind?: string; pending?: unknown; target?: JobControlTarget; request_id?: string; state?: string };
        if (value.kind === "action-result" && value.state === "applied" && value.request_id) applied.push(value.request_id);
        const pending = JobHumanRequest.safeParse(value.pending);
        if (!pending.success) return;
        const request = pending.data;
        requests.push(request);
        const action = { target: request.target, prompt_id: request.id, request_id: randomUUID() };
        if (decision === "stop" && request.kind === "question") child.send({ kind: "stop" });
        else if (request.kind === "question") child.send({ kind: "action", action: JobAction.parse({ ...action, action: "answer",
          answers: [{ question: request.questions[0]!.id, values: ["Blue"] }] }) });
        else if (decision === "approve" || decision === "deny") child.send({ kind: "action", action: JobAction.parse({ ...action, action: decision }) });
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        child.stdin!.end(JSON.stringify({ spec, completion, env: {}, lastMessageFile, redactions: ["fixture-secret-pi"],
          interactive: { provider, stateDir: state, gitPaths: [] } }));
        await exited;
        return { exit: JSON.parse(await readFile(completion, "utf8")), report: await readFile(lastMessageFile, "utf8").catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; }),
          requests, applied, output: await output };
      } finally { clearTimeout(timeout); }
    };
    const first = await execute(1, "approve");
    expect(first.exit.exit_code).toBe(0);
    expect(first.requests.map(request => request.kind)).toEqual(["question", "approval"]);
    expect(first.requests[1]).toMatchObject({ preview: "approved.txt", can_approve: true, target: first.requests[0]!.target });
    expect(first.applied).toHaveLength(2);
    expect(first.output).toContain('"type":"tool_execution_start"');
    expect(first.output).not.toContain("fixture-secret-pi");
    expect(first.report).toBe("Blue approved new");
    expect(await readFile(join(project, "approved.txt"), "utf8")).toBe("Blue");
    await rm(join(project, "approved.txt"));
    const denied = await execute(2, "deny");
    expect(denied.report).toBe("Blue declined continued");
    expect(denied.applied).toHaveLength(2);
    await expect(readFile(join(project, "approved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await execute(3, "expire")).applied).toHaveLength(1);
    expect((await execute(4, "stop")).exit).toMatchObject({ interrupted: true });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
