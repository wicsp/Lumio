import { describe, expect, test } from "bun:test";
import { SPEECH_PROTOCOL, SpeechClientMessage } from "@lumio/schema";
import { SPEECH_WORKLET, SPEECH_WORKLET_NAME } from "../../src/speech-worklet.ts";
import { webFiles } from "../../src/page.ts";
import { SpeechSession, type AudioSource, type SocketLike, type SpeechState } from "../../src/client/speech.ts";
import { insertText } from "../../src/client/speech-input.ts";
import { parseTerms, vocabularyProblem } from "../../src/client/speech-settings.ts";

type Resampler = { push(input: Float32Array): Int16Array[]; flush(): Int16Array[] };
const Resampler = new Function(`${SPEECH_WORKLET}; return Resampler;`)() as new (rate: number) => Resampler;

function tone(rate: number, hz: number, seconds: number, amplitude = 0.5): Float32Array {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
}

/** 按 128 样本的渲染块推入，模拟 AudioWorklet 的 process 调用。 */
function resample(rate: number, input: Float32Array): Int16Array[] {
  const r = new Resampler(rate);
  const frames: Int16Array[] = [];
  for (let i = 0; i < input.length; i += 128) frames.push(...r.push(input.subarray(i, i + 128)));
  return [...frames, ...r.flush()];
}

const rms = (samples: Int16Array) => Math.sqrt(samples.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / samples.length);
const join = (frames: Int16Array[]) => { const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0)); let o = 0; for (const f of frames) { out.set(f, o); o += f.length; } return out; };

describe("S1-4 speech worklet", () => {
  test("48 kHz and 44.1 kHz input becomes 40 ms frames of 16 kHz PCM16", () => {
    for (const rate of [48000, 44100]) {
      const frames = resample(rate, tone(rate, 1000, 1));
      const samples = join(frames);
      expect(Math.abs(samples.length - 16000)).toBeLessThanOrEqual(2);
      expect(frames.slice(0, -1).every(frame => frame.length === 640)).toBe(true);
      // 1 kHz 正弦（振幅 0.5）的 RMS 约 0.354，滤波后基本不变。
      expect(rms(samples.subarray(200))).toBeGreaterThan(0.33);
      expect(rms(samples.subarray(200))).toBeLessThan(0.37);
    }
  });

  test("content above 8 kHz is filtered instead of folding back into speech", () => {
    const samples = join(resample(48000, tone(48000, 10000, 1)));
    expect(rms(samples.subarray(200))).toBeLessThan(0.01);
  });

  test("flush returns the tail and a fresh resampler starts clean", () => {
    const r = new Resampler(48000);
    expect(r.push(tone(48000, 440, 0.01))).toEqual([]);
    const tail = r.flush();
    expect(tail).toHaveLength(1);
    expect(tail[0]!.length).toBe(160);
    expect(r.flush()).toEqual([]);
  });

  test("the processor registers under the shared name and the page serves the module same-origin", () => {
    const registered: string[] = [];
    new Function("registerProcessor", "AudioWorkletProcessor", "sampleRate", SPEECH_WORKLET)(
      (name: string) => registered.push(name), class {}, 48000);
    expect(registered).toEqual([SPEECH_WORKLET_NAME]);
    const file = webFiles({ js: "", css: "" }, { apiBase: "" }).get("/assets/speech-worklet.js");
    expect(file?.type).toStartWith("text/javascript");
    expect(file?.body).toBe(SPEECH_WORKLET);
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];
  closed = false;
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(new Event("open")); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
  get json() { return this.sent.filter((x): x is string => typeof x === "string").map(x => JSON.parse(x) as { type: string }); }
  get frames() { return this.sent.filter((x): x is ArrayBuffer => x instanceof ArrayBuffer); }
}

class FakeAudio implements AudioSource {
  emit?: (frame: ArrayBuffer) => void;
  closed = 0;
  flushed = 0;
  fail?: Error;
  async start(onFrame: (frame: ArrayBuffer) => void) { if (this.fail) throw this.fail; this.emit = onFrame; }
  async flush() { this.flushed++; this.emit?.(new ArrayBuffer(320)); }
  close() { this.closed++; }
}

let current: SpeechSession | undefined;
async function speech_stop(_audio: FakeAudio, _socket: FakeSocket) { await current!.stop(); }

function session() {
  const socket = new FakeSocket();
  const audio = new FakeAudio();
  const states: SpeechState[] = [];
  const events: string[] = [];
  const speech = new SpeechSession({
    token: "synthetic-token-0000", audio, url: "ws://hub.test/v2/speech/transcribe", socket: () => socket,
    handlers: {
      state: state => states.push(state),
      partial: text => events.push(`partial:${text}`),
      final: (text, truncated) => events.push(`final:${text}:${truncated}`),
      error: (message, partial) => events.push(`error:${message}:${partial}`),
    },
  });
  current = speech;
  return { socket, audio, states, events, speech };
}

const ready = { type: "ready", protocol: SPEECH_PROTOCOL, profile: `aip_${"0".repeat(26)}`, model: "fun-asr-realtime", vocabulary: true };

describe("S1-4 speech session", () => {
  test("authenticates in the first message, buffers audio until ready, and inserts only the final text", async () => {
    const { socket, audio, states, events, speech } = session();
    await Promise.resolve();
    audio.emit!(new ArrayBuffer(1280));
    socket.open();
    const start = SpeechClientMessage.parse(socket.json[0]);
    expect(start).toMatchObject({ type: "start", token: "synthetic-token-0000", format: "pcm16le-16k-mono", vocabulary: true });
    expect(socket.frames).toHaveLength(0);
    socket.receive(ready);
    expect(socket.frames).toHaveLength(1);
    expect(states).toEqual(["connecting", "listening"]);
    socket.receive({ type: "partial", seq: 0, text: "把任务" });
    socket.receive({ type: "partial", seq: 1, text: "把任务交给" });
    await speech.stop();
    expect(audio.flushed).toBe(1);
    expect(socket.frames).toHaveLength(2);
    expect(socket.json.at(-1)).toEqual({ type: "end" });
    socket.receive({ type: "final", text: "把任务交给 Codex", duration_ms: 1800, truncated: false });
    expect(events).toEqual(["partial:把任务", "partial:把任务交给", "final:把任务交给 Codex:false"]);
    expect(states.at(-1)).toBe("done");
    expect(socket.closed).toBe(true);
    expect(audio.closed).toBeGreaterThan(0);
  });

  test("releasing before ready still sends the queued audio and end once ready arrives", async () => {
    const { socket, audio, events } = session();
    await Promise.resolve();
    audio.emit!(new ArrayBuffer(1280));
    socket.open();
    await speech_stop(audio, socket);
    socket.receive(ready);
    expect(socket.frames).toHaveLength(2);
    expect(socket.json.map(m => m.type)).toEqual(["start", "end"]);
    socket.receive({ type: "final", text: "短句", duration_ms: 400, truncated: false });
    expect(events).toEqual(["final:短句:false"]);
  });

  test("errors keep the partial text, cancel tells the Hub, and closed connections fail", async () => {
    const a = session();
    a.socket.open(); a.socket.receive(ready);
    a.socket.receive({ type: "partial", seq: 0, text: "已经说了" });
    a.socket.receive({ type: "error", error: { code: "INTERNAL", message: "服务商出错" } });
    expect(a.events.at(-1)).toBe("error:服务商出错:已经说了");

    const b = session();
    b.socket.open(); b.socket.receive(ready);
    b.speech.cancel();
    expect(b.socket.json.at(-1)).toEqual({ type: "cancel" });
    expect(b.states.at(-1)).toBe("cancelled");
    expect(b.events).toEqual([]);

    const c = session();
    c.socket.open(); c.socket.onclose?.({} as CloseEvent);
    expect(c.states.at(-1)).toBe("error");
    expect(c.events[0]).toStartWith("error:");
  });

  test("a congested socket abandons the utterance instead of buffering without bound", async () => {
    const { socket, audio, states } = session();
    await Promise.resolve();
    socket.open(); socket.receive(ready);
    socket.bufferedAmount = 1024 * 1024;
    audio.emit!(new ArrayBuffer(1280));
    expect(states.at(-1)).toBe("error");
  });

  test("microphone failures become readable errors", async () => {
    const socket = new FakeSocket();
    const audio = new FakeAudio();
    audio.fail = new DOMException("denied", "NotAllowedError");
    const events: string[] = [];
    new SpeechSession({ token: "synthetic-token-0000", audio, url: "ws://hub.test/x", socket: () => socket, handlers: { error: message => events.push(message) } });
    await Promise.resolve(); await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(socket.closed).toBe(true);
  });
});

describe("S1-4 text and vocabulary helpers", () => {
  test("dictated text goes in at the cursor without replacing the rest", () => {
    expect(insertText("你好世界", 2, 2, "，")).toEqual({ value: "你好，世界", caret: 3 });
    expect(insertText("abc", 1, 2, "X")).toEqual({ value: "aXc", caret: 2 });
    expect(insertText("abc", 10, 12, "!")).toEqual({ value: "abc!", caret: 4 });
  });

  test("vocabulary lines are trimmed and checked against the Fun-ASR limits", () => {
    expect(parseTerms(" Lumio \n\nTailscale\r\n")).toEqual(["Lumio", "Tailscale"]);
    expect(vocabularyProblem(["Lumio", "青岚计划"])).toBeUndefined();
    expect(vocabularyProblem(["中".repeat(16)])).toContain("中".repeat(16));
    expect(vocabularyProblem(["one two three four five six seven eight"])).toBeDefined();
    expect(vocabularyProblem(["Lumio", "lumio"])).toBeDefined();
    expect(vocabularyProblem(Array.from({ length: 201 }, (_, i) => `t${i}`))).toBeDefined();
  });
});
