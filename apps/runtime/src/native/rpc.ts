import { NativeProcessScope } from "./process-scope.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { NativeError } from "./isolation.ts";
/** Bounded external protocol decoding. Only allowlisted fields leave this adapter. */
export type Wire = Record<string, any>;
export class NativeRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private scope?: NativeProcessScope;
  private serial = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: Wire) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  onEvent?: (method: string, params: Wire) => void;
  onRequest?: (method: string, id: string | number, params: Wire) => void;
  onExit?: () => void;
  constructor(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });
    this.child.stderr.on("data", () => {});
    if (this.child.pid) this.scope = new NativeProcessScope(this.child.pid);
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (line.length > 4 * 1024 * 1024) {
        this.child.kill();
        return;
      }
      let m: Wire;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof m.method === "string") {
        if (m.id !== undefined) this.onRequest?.(m.method, m.id, m.params ?? {});
        else this.onEvent?.(m.method, m.params ?? {});
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      m.error ? p.reject(new NativeError("native.rpc_failed")) : p.resolve(m.result ?? {});
    });
    const exit = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new NativeError("native.disconnected"));
      }
      this.pending.clear();
      this.onExit?.();
    };
    this.child.on("exit", exit);
    this.child.on("error", exit);
  }
  send(m: Wire) {
    if (this.child.stdin.destroyed) throw new NativeError("native.disconnected");
    this.child.stdin.write(JSON.stringify(m) + "\n");
  }
  request(method: string, params: Wire = {}, timeout = 45000): Promise<Wire> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeError("native.timeout"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  answer(id: string | number, result: Wire) {
    this.send({ id, result });
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "lumio", title: "Lumio Assistant", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
  }
  async stop(): Promise<boolean> {
    return this.scope ? await this.scope.stop() : false;
  }
}
