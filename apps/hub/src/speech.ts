import {
  SPEECH_LIMITS, SPEECH_PROTOCOL, SpeechClientMessage, SpeechServerMessage,
  type SpeechStart, type SpeechServerMessage as ServerMessage,
} from "@lumio/schema";
import type { Language } from "@lumio/platform";
import { HubError } from "./errors.ts";
import type { FunAsr, FunAsrStream } from "./fun-asr.ts";
import { errorMessage, withLanguage } from "./messages.ts";
import { SpeechConfiguration, speechError } from "./speech-config.ts";
import type { HubStore } from "./store.ts";

const BYTES_PER_SECOND = SPEECH_LIMITS.sample_rate * 2;
const MAX_AUDIO_BYTES = BYTES_PER_SECOND * SPEECH_LIMITS.max_utterance_seconds;
const MAX_WIRE_BYTES = 2 * SPEECH_LIMITS.max_frame_bytes;

export interface SpeechSocketData {
  lang: Language;
  session?: Transcription;
}

export class SpeechSessions {
  private readonly active = new Map<string, number>();

  constructor(
    private readonly config: SpeechConfiguration,
    private readonly provider: FunAsr,
    private readonly store: HubStore,
    private readonly now: () => Date,
    private readonly log: (line: string) => void,
  ) {}

  private reserve(owner: string) {
    const count = this.active.get(owner) ?? 0;
    if (count >= SPEECH_LIMITS.max_sessions_per_actor) throw speechError("CONFLICT", "session_limit");
    this.active.set(owner, count + 1);
    return () => {
      const left = (this.active.get(owner) ?? 1) - 1;
      if (left) this.active.set(owner, left);
      else this.active.delete(owner);
    };
  }

  handlers(): Bun.WebSocketHandler<SpeechSocketData> {
    return {
      maxPayloadLength: MAX_WIRE_BYTES,
      backpressureLimit: 128 * 1024,
      closeOnBackpressureLimit: true,
      open: ws => {
        ws.data.session = new Transcription(ws, this.config, this.provider, this.store,
          this.now, this.log, owner => this.reserve(owner));
      },
      message: (ws, frame) => ws.data.session?.message(frame),
      close: ws => {
        ws.data.session?.close("disconnected");
        delete ws.data.session;
      },
    };
  }
}

type Status = "waiting" | "opening" | "streaming" | "finishing" | "closed";
type Outcome = "completed" | "truncated" | "cancelled" | "disconnected" | "error";

class Transcription {
  private status: Status = "waiting";
  private timer?: ReturnType<typeof setTimeout>;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private upstream?: FunAsrStream;
  private releaseSlot?: () => void;
  private actor?: string;
  private profile?: string;
  private bytes = 0;
  private seq = 0;
  private truncated = false;
  private readonly segments = new Map<number, string>();

  constructor(
    private readonly ws: Bun.ServerWebSocket<SpeechSocketData>,
    private readonly config: SpeechConfiguration,
    private readonly provider: FunAsr,
    private readonly store: HubStore,
    private readonly now: () => Date,
    private readonly log: (line: string) => void,
    private readonly reserve: (owner: string) => () => void,
  ) {
    this.timeout(SPEECH_LIMITS.start_timeout_ms, () => this.fail(speechError("UNAUTHENTICATED", "start_timeout")));
  }

  private timeout(ms: number, action: () => void) {
    clearTimeout(this.timer);
    this.timer = setTimeout(action, ms);
  }

  private send(message: ServerMessage) {
    if (this.ws.send(JSON.stringify(SpeechServerMessage.parse(message))) === 0) this.close("disconnected");
  }

  private get duration() { return Math.floor(this.bytes * 1000 / BYTES_PER_SECOND); }

  private fail(cause: unknown) {
    if (this.status === "closed") return;
    const problem = cause instanceof HubError ? cause : speechError("INTERNAL", "provider_failed");
    try {
      this.send({ type: "error", error: {
        ...problem.details, code: problem.code,
        message: withLanguage(this.ws.data.lang, () => errorMessage(problem)),
      } });
    } finally {
      this.close("error");
    }
  }

  close(outcome: Outcome) {
    if (this.status === "closed") return;
    this.status = "closed";
    clearTimeout(this.timer);
    clearTimeout(this.durationTimer);
    this.releaseSlot?.();
    this.upstream?.close();
    this.segments.clear();
    this.log(JSON.stringify({ time: this.now().toISOString(), path: "/v2/speech/transcribe",
      actor_id: this.actor ?? null, profile_id: this.profile ?? null, duration_ms: this.duration,
      audio_bytes: this.bytes, outcome }));
    this.ws.close(outcome === "error" ? 1008 : 1000);
  }

  message(frame: string | Buffer) {
    if (this.status === "closed") return;
    try {
      if (typeof frame !== "string") {
        this.audio(frame);
        return;
      }
      let raw: unknown;
      try { raw = JSON.parse(frame); } catch { throw speechError("INVALID", "invalid_message"); }
      const result = SpeechClientMessage.safeParse(raw);
      if (!result.success) throw speechError("INVALID", "invalid_message");
      const message = result.data;
      if (this.status === "waiting") {
        if (message.type !== "start") throw speechError("INVALID", "start_required");
        this.start(message);
      } else if (message.type === "cancel") {
        this.close("cancelled");
      } else if (message.type === "end" && this.status === "streaming") {
        this.finish(false);
      } else if (message.type === "end" && this.status === "finishing" && this.truncated) {
        return;
      } else {
        throw speechError("INVALID", "invalid_message");
      }
    } catch (cause) {
      this.fail(cause);
    }
  }

  private start(message: SpeechStart) {
    const identity = this.store.authenticate("Bearer " + message.token, this.now());
    if (!identity) throw speechError("UNAUTHENTICATED", "invalid_token");
    this.actor = identity.actor.id;
    if (identity.actor.role !== "human") throw speechError("FORBIDDEN", "human_required");
    const { profile, connection, secret } = this.config.asr(identity.actor.id, message.profile);
    this.profile = profile.id;
    this.releaseSlot = this.reserve(identity.actor.id);
    this.store.activity(identity);
    this.status = "opening";
    this.timeout(SPEECH_LIMITS.idle_timeout_ms, () => this.fail(speechError("INTERNAL", "provider_timeout")));
    const vocabularyId = message.vocabulary ? this.config.vocabularyFor(connection, secret) : undefined;
    this.upstream = this.provider.open(secret, vocabularyId, {
        ready: () => {
          if (this.status !== "opening") throw speechError("INTERNAL", "provider_failed");
          this.status = "streaming";
          this.resetIdle();
          this.durationTimer = setTimeout(() => this.finish(true), SPEECH_LIMITS.max_utterance_seconds * 1000);
          this.send({ type: "ready", protocol: SPEECH_PROTOCOL, profile: profile.id, model: profile.model, vocabulary: !!vocabularyId });
        },
        result: (offset, text, final) => this.result(offset, text, final),
        done: () => {
          if (this.status !== "finishing") throw speechError("INTERNAL", "provider_failed");
          this.send({ type: "final", text: this.text(), duration_ms: this.duration, truncated: this.truncated });
          this.close(this.truncated ? "truncated" : "completed");
        },
        failed: () => this.fail(speechError("INTERNAL", "provider_failed")),
    });
  }

  private resetIdle() {
    this.timeout(SPEECH_LIMITS.idle_timeout_ms, () => this.finish(true));
  }

  private audio(frame: Buffer) {
    if (this.status === "finishing" && this.truncated) return;
    if (this.status !== "streaming") throw speechError("INVALID", this.status === "waiting" ? "start_required" : "not_ready");
    if (!frame.length || frame.length % 2 || frame.length > SPEECH_LIMITS.max_frame_bytes) {
      throw speechError("INVALID", "invalid_frame");
    }
    const audio = frame.subarray(0, MAX_AUDIO_BYTES - this.bytes);
    this.upstream!.send(audio);
    this.bytes += audio.length;
    if (this.bytes === MAX_AUDIO_BYTES) this.finish(true);
    else this.resetIdle();
  }

  private finish(truncated: boolean) {
    if (this.status !== "streaming") return;
    this.status = "finishing";
    this.truncated = truncated;
    clearTimeout(this.durationTimer);
    this.timeout(SPEECH_LIMITS.idle_timeout_ms, () => this.fail(speechError("INTERNAL", "provider_timeout")));
    try { this.upstream!.finish(); }
    catch (cause) { this.fail(cause); }
  }

  private text() {
    return [...this.segments].sort(([a], [b]) => a - b).map(([, text]) => text).join(" ");
  }

  private result(offset: number, text: string, final: boolean) {
    if (this.status !== "streaming" && this.status !== "finishing") throw speechError("INTERNAL", "provider_failed");
    if (text.length > SPEECH_LIMITS.max_text_chars) {
      this.fail(speechError("INTERNAL", "text_limit"));
      return;
    }
    if (final) this.segments.set(offset, text);
    const committed = this.text();
    const partial = final || this.segments.has(offset) ? committed : [committed, text].filter(Boolean).join(" ");
    if (partial.length > SPEECH_LIMITS.max_text_chars) {
      this.fail(speechError("INTERNAL", "text_limit"));
      return;
    }
    this.send({ type: "partial", seq: this.seq++, text: partial });
  }
}
