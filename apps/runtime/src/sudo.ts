import { text as msg } from "./messages.ts";
import { StringDecoder } from "node:string_decoder";
import { randomBytes } from "node:crypto";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmod, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { OperationRequest, OperationResult, PrivilegedStatus, PrivilegedReport, type JobSpec } from "@lumio/schema";
import type { RuntimeConfig } from "./config.ts";
import type { Queue } from "./queue.ts";

type Reply = { message?: string; stream?: "stdout" | "stderr"; data?: string; code?: number };
const write = (socket: Socket, value: Reply) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n"); };
export class SudoGate {
  private server?: Server;
  private jobs = new Map<string, { spec: JobSpec; controller: AbortController }>();
  private pending = new Set<Promise<void>>();
  private sockets = new Set<Socket>();
  private conflicts = new Set<string>();
  readonly path: string;
  constructor(private config: RuntimeConfig, private queue: Queue, private actor: () => string | undefined,
    private fetcher: typeof fetch, private signal: AbortSignal, private log: (line: string) => void) {
    this.path = join(config.stateDir, "sudo.sock");
    queue.db.exec("CREATE TABLE IF NOT EXISTS privileged_outbox (proposal TEXT PRIMARY KEY, report TEXT NOT NULL)");
  }
  async start() {
    await chmod(this.config.stateDir, 0o700);
    await rm(this.path, { force: true });
    this.server = createServer((socket) => {
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
      let input = "", received = false;
      const decoder = new StringDecoder("utf8");
      socket.on("error", () => {});
      socket.setTimeout(10_000, () => { if (!received) socket.destroy(); });
      socket.on("data", (chunk) => {
        if (received) return;
        input += decoder.write(chunk);
        if (input.length > 1_048_576) { socket.destroy(); return; }
        if (!input.includes("\n")) return;
        received = true; socket.setTimeout(0);
        const pending = this.handle(socket, input.slice(0, input.indexOf("\n"))).catch(() => {
          write(socket, { message: msg("sudo.request_failed_or_this_round_ended"), code: 1 });
        }).finally(() => { socket.end(); this.pending.delete(pending); });
        this.pending.add(pending);
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.path, resolve); });
    await chmod(this.path, 0o600);
  }
  begin(spec: JobSpec) {
    const token = randomBytes(32).toString("base64url");
    this.jobs.set(token, { spec, controller: new AbortController() });
    return { LUMIO_SUDO_SOCKET: this.path, LUMIO_SUDO_TOKEN: token };
  }
  end(job: string) {
    for (const [token, entry] of this.jobs) if (entry.spec.id === job) { entry.controller.abort(); this.jobs.delete(token); }
  }
  private request(path: string, body: unknown, signal: AbortSignal) {
    return this.fetcher(`${this.config.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  }
  private async handle(socket: Socket, input: string) {
    let value: { token?: string; argv?: unknown }; try { value = JSON.parse(input); } catch { write(socket, { message: msg("sudo.invalid_request"), code: 2 }); return; }
    const entry = typeof value.token === "string" ? this.jobs.get(value.token) : undefined;
    if (!entry || entry.controller.signal.aborted) { write(socket, { message: msg("sudo.only_available_within_a_round_dispatched_by_the_runtime"), code: 2 }); return; }
    if (!this.config.sudoCommand.length) { write(socket, { message: msg("sudo.this_runtime_does_not_support_privileged_commands"), code: 2 }); return; }
    const actor = this.actor() ?? entry.spec.runtime;
    const parsed = OperationRequest.safeParse({ operation: { op: "exec.privileged", args: { runtime: actor, job: entry.spec.id, argv: value.argv } }, reason: msg("sudo.agent_request_for_round", entry.spec.source?.round ?? 1) });
    if (!parsed.success || parsed.data.operation.op !== "exec.privileged" || !isAbsolute(parsed.data.operation.args.argv[0]!) || parsed.data.operation.args.argv.some((a) => a.includes("\0"))) {
      write(socket, { message: msg("sudo.program_must_be_an_absolute_path_with_valid_arguments"), code: 2 }); return;
    }
    const disconnected = new AbortController();
    socket.once("close", () => disconnected.abort());
    const signal = AbortSignal.any([this.signal, entry.controller.signal, disconnected.signal, AbortSignal.timeout(this.config.sudoTimeout * 1000)]);
    let proposal: string | undefined;
    while (!signal.aborted && !proposal) {
      try {
        const response = await this.request("/v1/operations", parsed.data, signal);
        if (!response.ok) { write(socket, { message: msg("sudo.hub_rejected_the_request"), code: 1 }); return; }
        const result = OperationResult.parse(await response.json());
        if (result.status !== "pending_approval") throw new Error("unexpected result");
        proposal = result.proposal.id;
      } catch { if (!signal.aborted) await sleep(this.config.pollSeconds * 1000, undefined, { signal }).catch(() => {}); }
    }
    if (!proposal) { write(socket, { message: msg("sudo.not_approved_timed_out_or_this_round_ended"), code: 1 }); return; }
    write(socket, { message: msg("sudo.submitted_request_waiting_for_user_approval", proposal) });
    while (!signal.aborted) {
      let status: PrivilegedStatus | undefined;
      try {
        const response = await this.request(`/v1/runtime/privileged/${proposal}`, undefined, signal);
        if (response.ok) status = PrivilegedStatus.parse(await response.json());
      } catch { /* Hub 离线时仍在超时内等待。 */ }
      if (signal.aborted) break;
      if (status?.status === "rejected" || status?.status === "expired") { write(socket, { message: status.status === "rejected" ? msg("sudo.user_rejected_this_command") : msg("sudo.request_expired"), code: 1 }); return; }
      if (status?.status === "accepted") {
        const started = new Date().toISOString();
        const code = await this.execute(status.approval, socket, AbortSignal.any([this.signal, entry.controller.signal, disconnected.signal]));
        const report = PrivilegedReport.parse({ proposal, job: entry.spec.id, status: code === 126 ? "refused" : code === 0 ? "done" : "failed", exit_code: code, started, finished: new Date().toISOString() });
        this.queue.db.query("INSERT INTO privileged_outbox VALUES (?,?)").run(proposal, JSON.stringify(report));
        write(socket, { code }); return;
      }
      await sleep(this.config.pollSeconds * 1000, undefined, { signal }).catch(() => {});
    }
    write(socket, { message: msg("sudo.not_approved_timed_out_or_this_round_ended"), code: 1 });
  }
  private async execute(approval: unknown, socket: Socket, signal: AbortSignal): Promise<number> {
    if (signal.aborted) return 126;
    return new Promise<number>((resolve) => {
      const child = spawn(this.config.sudoCommand[0]!, this.config.sudoCommand.slice(1), { shell: false, detached: true, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
      const stop = () => { child.stdout.resume(); child.stderr.resume(); try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch {} };
      signal.addEventListener("abort", stop, { once: true });
      const timeout = setTimeout(stop, 1_800_000);
      child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(approval));
      for (const stream of ["stdout", "stderr"] as const) child[stream].on("data", (data: Buffer) => {
        if (!socket.destroyed && !socket.write(JSON.stringify({ stream, data: data.toString("base64") }) + "\n")) {
          child[stream].pause(); socket.once("drain", () => child[stream].resume());
        }
      });
      const finish = (code: number) => { clearTimeout(timeout); signal.removeEventListener("abort", stop); resolve(code); };
      child.once("error", () => finish(126)); child.once("close", (code) => finish(code ?? 137));
    });
  }
  async flush() {
    const rows = this.queue.db.query<{ proposal: string; report: string }, []>("SELECT * FROM privileged_outbox ORDER BY rowid").all();
    for (const row of rows) {
      if (this.signal.aborted || this.conflicts.has(row.proposal)) continue;
      try {
        const response = await this.request("/v1/runtime/privileged", JSON.parse(row.report), this.signal);
        if (response.ok) this.queue.db.query("DELETE FROM privileged_outbox WHERE proposal=?").run(row.proposal);
        else if (response.status === 409) { this.conflicts.add(row.proposal); this.log(msg("sudo.privileged_command_report_conflict_409_retained_for_manual_handling", row.proposal)); }
      } catch { break; }
    }
  }
  async close() {
    for (const entry of this.jobs.values()) entry.controller.abort();
    for (const socket of this.sockets) socket.destroy();
    this.server?.close(); await Promise.all(this.pending); await rm(this.path, { force: true });
  }
}

export async function runSudo(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!env.LUMIO_SUDO_SOCKET || !env.LUMIO_SUDO_TOKEN) { console.error(msg("sudo.only_available_within_a_round_dispatched_by_the_runtime")); return 2; }
  if (args[0] !== "--" || !args[1] || !isAbsolute(args[1])) { console.error(msg("sudo.usage_lumio_runtime_sudo_absolute_program_path_arguments")); return 2; }
  return new Promise<number>((resolve) => {
    const socket = createConnection(env.LUMIO_SUDO_SOCKET!);
    let input = "", code: number | undefined;
    const decoder = new StringDecoder("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ token: env.LUMIO_SUDO_TOKEN, argv: args.slice(1) }) + "\n"));
    socket.on("data", (chunk) => {
      input += decoder.write(chunk);
      let end: number;
      while ((end = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 1);
        try {
          const reply = JSON.parse(line) as Reply;
          if (reply.message) console.error(reply.message);
          if (reply.stream && reply.data) process[reply.stream].write(Buffer.from(reply.data, "base64"));
          if (reply.code !== undefined) code = reply.code;
        } catch { socket.destroy(); }
      }
    });
    socket.on("error", () => { console.error(msg("sudo.could_not_contact_this_round_s_runtime")); });
    socket.once("close", () => resolve(code ?? 2));
  });
}
