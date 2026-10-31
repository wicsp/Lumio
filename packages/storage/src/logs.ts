import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Id, RunLogEvent } from "@lumio/schema";
import { newId } from "@lumio/foundation";
import { StorageError } from "./errors.ts";

/** An active stream may have one incomplete final line; archived segments must be complete. */
export function parseLogSegment(bytes: Uint8Array, options: { run: string; active: boolean; next?: number }) {
  const incomplete = bytes.length > 0 && bytes.at(-1) !== 10;
  if (incomplete && !options.active) throw new StorageError("CORRUPT", "归档日志的末行不完整");
  const complete = incomplete ? bytes.subarray(0, bytes.lastIndexOf(10) + 1) : bytes;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(complete); }
  catch { throw new StorageError("CORRUPT", "日志含有无效的 UTF-8 数据"); }
  const lines = text.split("\n"); lines.pop();
  const events: RunLogEvent[] = [], seen = new Set<string>(); let next = options.next ?? 1;
  for (const line of lines) {
    let event: RunLogEvent;
    try { event = RunLogEvent.parse(JSON.parse(line)); }
    catch { throw new StorageError("CORRUPT", "日志中间存在损坏的记录"); }
    if (event.run !== options.run || event.sequence !== next || seen.has(event.id)) throw new StorageError("CORRUPT", "日志的所属运行、顺序或事件编号不一致");
    seen.add(event.id); next++; events.push(event);
  }
  return { events, next, incomplete };
}

/** A run directory is reserved exclusively once: a crashed run is inspected, never silently resumed or replayed. */
export class RunLogWriter {
  private sequence = 0;
  private segment = 1;
  private size = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private failed = false;
  private constructor(private readonly directory: string, readonly run: string, private handle: FileHandle,
    private readonly options: { segmentBytes: number; now(): Date }) {}
  static async create(root: string, run: string, options: { segmentBytes?: number; now?: () => Date } = {}): Promise<RunLogWriter> {
    if (!Id.safeParse(run).success) throw new StorageError("INVALID", "运行 ID 不合法");
    const directory = join(root, run);
    const segmentBytes = options.segmentBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1) throw new StorageError("INVALID", "日志分段大小不合法");
    await mkdir(root, { recursive: true, mode: 0o700 });
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new StorageError("CONFLICT", "这个运行已有日志，不能启动第二个写入者"); throw cause; }
    return new RunLogWriter(directory, run, await open(join(directory, "000001.active.jsonl"), "wx", 0o600), { segmentBytes, now: options.now ?? (() => new Date()) });
  }
  private path(active: boolean): string { return join(this.directory, `${String(this.segment).padStart(6, "0")}${active ? ".active" : ""}.jsonl`); }
  private async seal(): Promise<void> {
    await this.handle.sync(); await this.handle.close(); await rename(this.path(true), this.path(false));
  }
  append(type: string, payload: Record<string, unknown>): Promise<RunLogEvent> {
    if (this.closing || this.failed) return Promise.reject(new StorageError("CONFLICT", "日志已经关闭或写入失败"));
    const pending = this.queue.then(async () => {
      if (this.failed) throw new StorageError("CONFLICT", "日志写入已失败");
      const time = this.options.now();
      const event = RunLogEvent.parse({ schema_version: 1, id: newId("evt", time, randomBytes), run: this.run,
        sequence: this.sequence + 1, time: time.toISOString(), type, payload });
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      if (this.size > 0 && this.size + bytes.length > this.options.segmentBytes) {
        await this.seal(); this.segment++; this.size = 0; this.handle = await open(this.path(true), "wx", 0o600);
      }
      await this.handle.writeFile(bytes); this.sequence++; this.size += bytes.length; return event;
    });
    this.queue = pending.catch((cause) => { this.failed = true; throw cause; });
    void this.queue.catch(() => {}); // append callers still receive the original failure.
    return pending;
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      try { await this.queue; if (!this.failed) await this.seal(); }
      finally { if (this.failed) await this.handle.close().catch(() => {}); }
    })();
    return this.closing;
  }
}

async function* segmentEvents(path: string, run: string, next: number, active: boolean): AsyncGenerator<RunLogEvent, { next: number; incomplete: boolean; completeBytes: number }> {
  let pending = Buffer.alloc(0), completeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, end + 1);
      if (line.length > 4 * 1024 * 1024) throw new StorageError("CORRUPT", "日志单行超过读取上限");
      const parsed = parseLogSegment(line, { run, next, active: false });
      next = parsed.next; completeBytes += line.length; pending = pending.subarray(end + 1);
      yield parsed.events[0]!;
    }
    if (pending.length > 4 * 1024 * 1024) throw new StorageError("CORRUPT", "日志单行超过读取上限");
  }
  if (pending.length && !active) throw new StorageError("CORRUPT", "归档日志的末行不完整");
  return { next, incomplete: pending.length > 0, completeBytes };
}
export async function validateArchivedRunLog(path: string, run: string): Promise<void> {
  const seen = new Set<string>();
  for await (const event of segmentEvents(path, run, 1, false)) {
    if (seen.has(event.id)) throw new StorageError("CORRUPT", "日志包含重复事件编号"); seen.add(event.id);
  }
}
export async function* iterateRunLog(root: string, run: string): AsyncGenerator<RunLogEvent, { incomplete: boolean; active: boolean; next: number; path?: string; completeBytes: number }> {
  if (!Id.safeParse(run).success) throw new StorageError("INVALID", "运行 ID 不合法");
  const directory = join(root, run), names = (await readdir(directory)).sort();
  const seen = new Set<string>(); let next = 1, incomplete = false, active = false, completeBytes = 0, path: string | undefined;
  for (const [index, name] of names.entries()) {
    const match = /^(\d{6})(\.active)?\.jsonl$/.exec(name);
    if (!match || Number(match[1]) !== index + 1 || (match[2] && index !== names.length - 1)) throw new StorageError("CORRUPT", "日志分段缺失、重复或命名不合法");
    path = join(directory, name); const iterator = segmentEvents(path, run, next, !!match[2]);
    while (true) {
      const item = await iterator.next();
      if (item.done) { next = item.value.next; incomplete = item.value.incomplete; completeBytes = item.value.completeBytes; break; }
      const event = item.value;
      if (seen.has(event.id)) throw new StorageError("CORRUPT", "日志包含重复事件编号"); seen.add(event.id); yield event;
    }
    active = !!match[2];
  }
  return { incomplete, active, next, path, completeBytes };
}
export async function readRunLog(root: string, run: string): Promise<{ events: RunLogEvent[]; incomplete: boolean; active: boolean }> {
  const events: RunLogEvent[] = [], iterator = iterateRunLog(root, run);
  while (true) {
    const item = await iterator.next();
    if (item.done) return { events, incomplete: item.value.incomplete, active: item.value.active };
    events.push(item.value);
  }
}
/** Only the runtime that has stopped the old process may finalize its interrupted trace; this never resumes execution. */
export async function finalizeInterruptedLog(root: string, run: string): Promise<void> {
  const iterator = iterateRunLog(root, run); let state;
  try { while (true) { const item = await iterator.next(); if (item.done) { state = item.value; break; } } }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; }
  if (!state.active || !state.path) return;
  const handle = await open(state.path, "r+");
  try { await handle.truncate(state.completeBytes); } finally { await handle.close(); }
  const append = await open(state.path, "a"), time = new Date();
  try {
    const event = RunLogEvent.parse({ schema_version: 1, id: newId("evt", time, randomBytes), run, sequence: state.next,
      time: time.toISOString(), type: "recovery", payload: { status: "unknown", discarded_tail: state.incomplete } });
    await append.writeFile(JSON.stringify(event) + "\n"); await append.sync();
  } finally { await append.close(); }
  await rename(state.path, state.path.replace(".active.jsonl", ".jsonl"));
}
