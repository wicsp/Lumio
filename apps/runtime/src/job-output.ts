import { isAbsolute, relative, resolve } from "node:path";
import { JobActivityEvent, type AgentRun } from "@lumio/schema";

type Payload<T = JobActivityEvent> = T extends { at: string } ? Omit<T, "at"> : never;
type Engine = AgentRun["engine"];
type Wire = Record<string, any>;
const MAX_LINE = 4 * 1024 * 1024;

function fileLabels(input: unknown[], workdir: string): string[] {
  return input.slice(0, 20).flatMap(path => {
    if (typeof path !== "string" || !path || path.includes("[REDACTED]")) return [];
    const name = relative(resolve(workdir), resolve(workdir, path));
    return name && !isAbsolute(name) && name !== ".." && !name.startsWith("../") && name.length <= 240
      && !/[\r\n\x00-\x1f]/.test(name) ? [name] : [];
  });
}

export function commandLabel(command: unknown): string {
  if (typeof command !== "string") return "Shell";
  const text = command.replace(/^\s*\S*\/(?:ba|z)?sh -l?c ['"]?/, "").trim();
  const common = /^(bun (?:test|run check)|npm test|pnpm test|git (?:status|diff|log|fetch)|cargo test|go test|pytest)(?:\s|['"]|$)/.exec(text);
  return common?.[1] ?? "Shell";
}

export class JobOutput {
  private chunks: Buffer[] = [];
  private size = 0;
  private skip = false;
  private readonly active = new Map<string, Extract<JobActivityEvent, { type: "tool_started" }>["tool"]>();
  report?: string;
  sessionId?: string;
  constructor(private readonly engine: Engine, private readonly cwd: string, private readonly emit: (event: Payload) => void = () => {}, private readonly redact: (value: string) => string = value => value) {}

  push(chunk: Buffer, end = false) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      if (!this.skip && this.size + part.length <= MAX_LINE) {
        this.chunks.push(part);
        this.size += part.length;
      } else {
        this.skip = true;
        this.chunks = [];
        this.size = 0;
      }
      if (newline !== -1) this.flushLine();
      start = newline === -1 ? chunk.length : newline + 1;
    }
    if (end) this.flushLine();
  }
  private flushLine() {
    if (!this.skip && this.size) {
      let data: Wire | undefined;
      try { data = JSON.parse(Buffer.concat(this.chunks, this.size).toString("utf8")); } catch { /* ignore invalid output */ }
      if (data && typeof data === "object" && !Array.isArray(data)) this.row(data);
    }
    this.chunks = [];
    this.size = 0;
    this.skip = false;
  }

  private start(id: unknown, kind: "command" | "files" | "tool" | "search", label: string, files?: string[]) {
    if (typeof id !== "string" || !id || id.length > 128 || this.redact(id) !== id || this.active.has(id) || this.active.size >= 32) return;
    const clean = files?.filter(value => this.redact(value) === value);
    const tool = { id, kind, label: this.redact(label), ...(clean?.length ? { files: clean } : {}) };
    this.active.set(id, tool);
    this.emit({ type: "tool_started", tool });
  }
  private finish(id: unknown, outcome: "completed" | "declined" | "failed" | "unknown", files?: string[]) {
    if (typeof id !== "string") return;
    const start = this.active.get(id);
    if (!start) return;
    this.active.delete(id);
    const clean = files?.filter(value => this.redact(value) === value);
    this.emit({ type: "tool_finished", tool: { ...start, ...(clean?.length ? { files: clean } : {}) }, outcome });
  }

  private session(value: unknown) {
    if (typeof value === "string" && this.redact(value) === value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) this.sessionId = value;
  }
  row(data: Wire) {
    if (this.engine === "codex") {
      const item = data.item;
      if (data.type === "thread.started") this.session(data.thread_id);
      else if (data.type === "turn.started") this.emit({ type: "engine", activity: "started" });
      else if (["turn.failed", "error"].includes(data.type)) this.emit({ type: "error", category: "engine" });
      else if (item && ["item.started", "item.completed"].includes(data.type)) {
        const last = data.type === "item.completed";
        const status = item.status === "failed" || item.status === "declined" ? item.status : "completed";
        if (item.type === "agent_message" && last) this.emit({ type: "engine", activity: "responded" });
        if (item.type === "todo_list" && last) this.emit({ type: "engine", activity: "plan_updated" });
        if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) {
          const files = item.type === "file_change" && Array.isArray(item.changes) ? fileLabels(item.changes.map((change: Wire) => change?.path), this.cwd) : undefined;
          const [kind, label] = item.type === "command_execution" ? ["command", commandLabel(item.command)] as const
            : item.type === "file_change" ? ["files", "Edit"] as const
            : item.type === "web_search" ? ["search", "Search"] as const : ["tool", "MCP"] as const;
          this.start(item.id, kind, label, files);
          if (last) this.finish(item.id, status, files);
        }
      }
      return;
    }
    if (this.engine !== "claude-code") return;
    if (data.type === "result") {
      this.session(data.session_id);
      if (typeof data.result === "string") this.report = data.result.slice(0, 100_000);
      return;
    }
    if (data.type === "system") {
      if (data.subtype === "init") { this.session(data.session_id); this.emit({ type: "engine", activity: "started" }); }
      if (["api_retry", "retry"].includes(data.subtype)) this.emit({ type: "engine", activity: "retrying" });
      return;
    }
    if (!Array.isArray(data.message?.content)) return;
    for (const item of data.message.content) {
      if (!item || typeof item !== "object") continue;
      if (data.type === "assistant" && item.type === "tool_use") {
        const name = typeof item.name === "string" && /^[A-Za-z][\w-]{0,63}$/.test(item.name) ? item.name : "Tool";
        const edit = ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name);
        this.start(item.id, name === "Bash" ? "command" : edit ? "files" : "tool",
          name === "Bash" ? commandLabel(item.input?.command) : name,
          edit ? fileLabels([item.input?.file_path ?? item.input?.notebook_path], this.cwd) : undefined);
      } else if (data.type === "user" && item.type === "tool_result") {
        this.finish(item.tool_use_id, item.is_error ? "failed" : "completed");
      } else if (data.type === "assistant" && item.type === "text") this.emit({ type: "engine", activity: "responded" });
    }
  }
}

export type JobActivityPayload = Payload;
