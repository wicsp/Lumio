import { createHash, randomUUID } from "node:crypto";
import { DASHSCOPE_BASE_URLS, SPEECH_LIMITS } from "@lumio/schema";
import { HubError } from "./errors.ts";

export const FUN_ASR_MODEL = "fun-asr-realtime";
const API = DASHSCOPE_BASE_URLS.beijing;
const STREAM_URL = API.replace(/^https:/, "wss:") + "/api-ws/v1/inference";
const VOCABULARY_URL = API + "/api/v1/services/audio/asr/customization";
const MAX_QUEUED_AUDIO = SPEECH_LIMITS.max_frame_bytes * 8;

export interface FunAsrOptions {
  fetch?: typeof fetch;
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

interface StreamEvents {
  ready(): void;
  result(start: number, text: string, final: boolean): void;
  done(): void;
  failed(): void;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

const vocabularyError = () => new HubError("INTERNAL", { key: "speech.vocabulary_failed", args: [] });
const upstreamError = () => new HubError("INTERNAL", { key: "speech.provider_failed", args: [] });

/** Only the fixed Beijing endpoints receive the connection's private API key. */
export class FunAsr {
  constructor(private readonly options: FunAsrOptions = {}, private readonly signal?: AbortSignal) {}

  private async vocabulary(key: string, action: string, input: object) {
    try {
      const deadline = AbortSignal.timeout(SPEECH_LIMITS.idle_timeout_ms);
      const response = await (this.options.fetch ?? fetch)(VOCABULARY_URL, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        signal: this.signal ? AbortSignal.any([this.signal, deadline]) : deadline,
        body: JSON.stringify({ model: "speech-biasing", input: { action, ...input } }),
      });
      const body = object(await response.json());
      if (!response.ok || body.code || !body.output || typeof body.output !== "object") throw vocabularyError();
      return object(body.output);
    } catch {
      throw vocabularyError();
    }
  }

  async findVocabulary(key: string, connection: string) {
    // The stable prefix recovers a list created just before a lost response or Hub restart.
    const prefix = this.prefix(connection);
    const output = await this.vocabulary(key, "list_vocabulary", { prefix, page_index: 0, page_size: 10 });
    if (!Array.isArray(output?.vocabulary_list)) throw vocabularyError();
    const ids = output.vocabulary_list.map(row => object(row).vocabulary_id)
      .filter((id): id is string => typeof id === "string" && id.startsWith("vocab-" + prefix + "-"));
    if (ids.length > 1) throw vocabularyError();
    return ids[0];
  }

  private prefix(connection: string) {
    return createHash("sha256").update(connection).digest("hex").slice(0, 10);
  }

  async createVocabulary(key: string, connection: string, terms: string[]) {
    const output = await this.vocabulary(key, "create_vocabulary", {
      target_model: FUN_ASR_MODEL,
      prefix: this.prefix(connection),
      vocabulary: terms.map(text => ({ text, weight: 4 })),
    });
    if (typeof output?.vocabulary_id !== "string" || !output.vocabulary_id) throw vocabularyError();
    return output.vocabulary_id;
  }

  async updateVocabulary(key: string, id: string, terms: string[]) {
    await this.vocabulary(key, "update_vocabulary", {
      vocabulary_id: id,
      vocabulary: terms.map(text => ({ text, weight: 4 })),
    });
  }

  async vocabularyReady(key: string, id: string) {
    const output = await this.vocabulary(key, "query_vocabulary", { vocabulary_id: id });
    return output?.status === "OK";
  }

  async deleteVocabulary(key: string, id: string) {
    await this.vocabulary(key, "delete_vocabulary", { vocabulary_id: id });
  }

  open(key: string, vocabularyId: string | undefined, events: StreamEvents): FunAsrStream {
    const headers = { Authorization: "Bearer " + key };
    const socket = this.options.connect?.(STREAM_URL, headers) ?? new WebSocket(STREAM_URL, { headers });
    return new FunAsrStream(socket, vocabularyId, events);
  }
}

export class FunAsrStream {
  private readonly task = randomUUID();
  private closed = false;

  constructor(private readonly socket: WebSocket, vocabularyId: string | undefined, events: StreamEvents) {
    socket.onopen = () => {
      if (this.closed) return;
      try {
        this.control("run-task", {
          task_group: "audio", task: "asr", function: "recognition", model: FUN_ASR_MODEL,
          parameters: { format: "pcm", sample_rate: SPEECH_LIMITS.sample_rate, ...(vocabularyId ? { vocabulary_id: vocabularyId } : {}) },
          input: {},
        });
      } catch {
        events.failed();
      }
    };
    socket.onclose = socket.onerror = () => { if (!this.closed) events.failed(); };
    socket.onmessage = ({ data }) => {
      if (this.closed) return;
      try {
        if (typeof data !== "string" || data.length > 1_000_000) throw upstreamError();
        const message = object(JSON.parse(data));
        const header = object(message.header);
        if (header.task_id !== this.task) throw upstreamError();
        switch (header.event) {
          case "task-started": events.ready(); break;
          case "task-finished": events.done(); break;
          case "task-failed": events.failed(); break;
          case "result-generated": {
            const sentence = object(object(object(message.payload).output).sentence);
            if (sentence.heartbeat || typeof sentence.text !== "string" || !sentence.text) break;
            if (typeof sentence.begin_time !== "number" || !Number.isFinite(sentence.begin_time)) throw upstreamError();
            events.result(sentence.begin_time, sentence.text, sentence.sentence_end === true);
            break;
          }
        }
      } catch {
        events.failed();
      }
    };
  }

  private control(action: string, payload: object) {
    this.socket.send(JSON.stringify({ header: { action, task_id: this.task, streaming: "duplex" }, payload }));
  }

  send(frame: Buffer) {
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_QUEUED_AUDIO) throw upstreamError();
    this.socket.send(frame);
  }

  finish() {
    if (this.socket.readyState !== WebSocket.OPEN) throw upstreamError();
    this.control("finish-task", { input: {} });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
    this.socket.terminate();
  }
}
