/** V0-0 only: no production imports, no raw payload logging. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

// Wire payloads deliberately stay outside the production schema during the spike.
export type Wire = Record<string, any>;
export class CodexRpc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: Wire[] = [];
  readonly methods: string[] = [];
  private serial = 0;
  private pending = new Map<number, { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  requestHandler?: (message: Wire) => Promise<Wire>;
  constructor(readonly home: string, readonly cwd: string, options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, CODEX_HOME: home };
    for (const key of ["OPENAI_API_KEY", "OPENAI_API_BASE", "OPENAI_BASE_URL", "CODEX_API_KEY"]) delete env[key];
    this.child = spawn("codex", ["app-server", "--listen", "stdio://", ...(options.args ?? [])], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    // stderr may contain provider diagnostics: consume, never print or persist it.
    this.child.stderr.on("data", () => {});
    createInterface({ input: this.child.stdout }).on("line", line => {
      let message: Wire;
      try { message = JSON.parse(line) as Wire; } catch { return; }
      if (message.method) {
        this.methods.push(String(message.method)); this.events.push(message);
        if (message.id !== undefined) void this.answer(message);
      } else {
        const entry = this.pending.get(message.id as number);
        if (entry) {
          clearTimeout(entry.timer); this.pending.delete(message.id as number);
          if (message.error) entry.reject(new Error(`RPC ${String(message.error.code)} (raw diagnostic suppressed)`));
          else entry.resolve((message.result ?? {}) as Wire);
        }
      }
    });
    this.child.on("exit", () => { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("app-server exited")); } this.pending.clear(); });
    this.child.on("error", () => { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("app-server unavailable")); } this.pending.clear(); });
  }
  private async answer(message: Wire): Promise<void> {
    try { this.send({ id: message.id, result: this.requestHandler ? await this.requestHandler(message) : { decision: "decline" } }); }
    catch { this.send({ id: message.id, error: { code: -32000, message: "spike handler rejected request" } }); }
  }
  send(message: Wire): void { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + "\n"); }
  request(method: string, params: Wire = {}, timeout = 45000): Promise<Wire> {
    const id = ++this.serial;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); },timeout);
      this.pending.set(id,{resolve,reject,timer}); this.send({id,method,params});
    });
  }
  async initialize(): Promise<Wire> {
    const result = await this.request("initialize", {clientInfo:{name:"lumio_v0_spike",title:"Lumio V0 synthetic spike",version:"0.0.0"},capabilities:{experimentalApi:true}});
    this.send({method:"initialized",params:{}}); return result;
  }
  async wait(predicate: (event: Wire) => boolean, after = 0, timeout = 120000): Promise<Wire> {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const found = this.events.slice(after).find(predicate); if (found) return found;
      if (this.child.exitCode !== null || this.child.signalCode) throw new Error("app-server exited while waiting");
      await Bun.sleep(30);
    }
    throw new Error("event wait timeout");
  }
  async turn(threadId: string, text: string, params: Wire = {}): Promise<Wire> {
    const after = this.events.length;
    const started = await this.request("turn/start",{threadId,input:[{type:"text",text}],...params});
    const id = started.turn?.id;
    return this.wait(e=>e.method==="turn/completed" && e.params?.threadId===threadId && (!id || e.params?.turn?.id===id),after);
  }
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode) return;
    this.child.kill(signal);
    await Promise.race([new Promise<void>(resolve=>this.child.once("exit",()=>resolve())),Bun.sleep(3000)]);
    if (this.child.exitCode === null && !this.child.signalCode) this.child.kill("SIGKILL");
  }
}
export function shape(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return {type:"string",length:value.length};
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,shape(v)]));
  return typeof value;
}
