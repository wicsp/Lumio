/**
 * 语音输入的浏览器端（ADR 0055，S1-4）：麦克风 → AudioWorklet（16 kHz PCM16）→ 同源 WebSocket → Hub → Fun-ASR。
 * 音频只在内存里按帧转发，不保存；识别结果交给调用方插入输入框，由人确认后再发送。
 *
 * SpeechSession 只管协议（可注入 WebSocket 与音频源，便于测试）；BrowserAudio 管麦克风与 worklet。
 */
import { SPEECH_LIMITS, SPEECH_PROTOCOL, SpeechServerMessage } from "@lumio/schema";
import { SPEECH_WORKLET_NAME } from "../speech-worklet.ts";
import { apiBase } from "./api.ts";
import { newRequestId } from "./commands.ts";
import { t } from "./i18n.ts";

export const SPEECH_PATH = "/v2/speech/transcribe";
export const SPEECH_WORKLET_URL = "/assets/speech-worklet.js";
/** 等 ready 期间最多缓存的音频（约 5 秒），超过即放弃这一句。 */
const MAX_QUEUED_BYTES = SPEECH_LIMITS.sample_rate * 2 * 5;
/** WebSocket 发送缓冲超过这个值说明网络跟不上，放弃这一句而不是无限堆积。 */
const MAX_BUFFERED_BYTES = 512 * 1024;
const FINAL_TIMEOUT_MS = 8000;
const FLUSH_TIMEOUT_MS = 600;

export type SpeechState = "connecting" | "listening" | "finishing" | "done" | "cancelled" | "error";

export interface SpeechHandlers {
  state?(state: SpeechState): void;
  partial?(text: string): void;
  final?(text: string, truncated: boolean): void;
  /** 出错时调用；`partial` 是出错前最后一次临时文本，调用方应保留它（S1-0：不丢已收到的文字）。 */
  error?(message: string, partial: string): void;
}

export interface AudioSource {
  /** 开始采集；每帧 PCM16LE 调用一次 onFrame。 */
  start(onFrame: (frame: ArrayBuffer) => void): Promise<void>;
  /** 送出最后不足一帧的样本。 */
  flush(): Promise<void>;
  close(): void;
}

export interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

export function speechUrl(location: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${apiBase()}${SPEECH_PATH}`;
}

/** 浏览器是否能录音：麦克风只在安全上下文（HTTPS 或 localhost）开放（ADR 0055 第 6 节）。 */
export function speechSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia
    && typeof AudioWorkletNode !== "undefined" && typeof WebSocket !== "undefined";
}

export class SpeechSession {
  private socket: SocketLike;
  private ready = false;
  private ending = false;
  private queue: ArrayBuffer[] = [];
  private queued = 0;
  private partialText = "";
  private current: SpeechState = "connecting";
  private finalTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly options: {
      token: string;
      audio: AudioSource;
      handlers: SpeechHandlers;
      url?: string;
      socket?: (url: string) => SocketLike;
      profile?: string;
    },
  ) {
    const url = options.url ?? speechUrl();
    this.socket = options.socket ? options.socket(url) : new WebSocket(url) as unknown as SocketLike;
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => this.socket.send(JSON.stringify({
      type: "start", protocol: SPEECH_PROTOCOL, token: options.token, request_id: newRequestId("speech"),
      format: "pcm16le-16k-mono", vocabulary: true, ...(options.profile ? { profile: options.profile } : {}),
    }));
    this.socket.onmessage = event => this.message(event.data);
    this.socket.onclose = () => { if (this.active) this.fail(t("The speech connection closed.")); };
    this.socket.onerror = () => { if (this.active) this.fail(t("Couldn't connect to speech input on the Hub.")); };
    this.emit("connecting");
    options.audio.start(frame => this.frame(frame)).catch((cause: unknown) => this.fail(microphoneError(cause)));
  }

  get state(): SpeechState { return this.current; }
  private get active(): boolean { return this.current === "connecting" || this.current === "listening" || this.current === "finishing"; }

  /** 松手：送完剩余音频，请求定稿。 */
  async stop(): Promise<void> {
    if (!this.active || this.ending) return;
    this.ending = true;
    this.emit("finishing");
    await this.options.audio.flush().catch(() => {});
    this.options.audio.close();
    if (!this.active) return;
    if (this.ready) this.sendEnd();
    this.finalTimer = setTimeout(() => { if (this.active) this.fail(t("Speech recognition took too long. Try again.")); }, FINAL_TIMEOUT_MS);
  }

  /** 放弃这一句：Hub 关闭到服务商的连接，不返回定稿。 */
  cancel(): void {
    if (!this.active) return;
    this.emit("cancelled");
    if (this.socket.readyState === OPEN) this.socket.send(JSON.stringify({ type: "cancel" }));
    this.cleanup();
  }

  private sendEnd(): void {
    for (const frame of this.queue) this.socket.send(frame);
    this.queue = []; this.queued = 0;
    this.socket.send(JSON.stringify({ type: "end" }));
  }

  private frame(frame: ArrayBuffer): void {
    if (!this.active) return;
    if (this.ready && this.socket.readyState === OPEN) {
      if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.fail(t("The network is too slow for speech input right now.")); return; }
      this.socket.send(frame);
      return;
    }
    this.queue.push(frame);
    this.queued += frame.byteLength;
    if (this.queued > MAX_QUEUED_BYTES) this.fail(t("Speech input didn't start in time. Try again."));
  }

  private message(data: unknown): void {
    if (!this.active || typeof data !== "string") return;
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { return; }
    const parsed = SpeechServerMessage.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "ready") {
      this.ready = true;
      if (this.ending) { this.sendEnd(); return; }
      for (const frame of this.queue) this.socket.send(frame);
      this.queue = []; this.queued = 0;
      this.emit("listening");
    } else if (message.type === "partial") {
      this.partialText = message.text;
      this.options.handlers.partial?.(message.text);
    } else if (message.type === "final") {
      this.emit("done");
      this.cleanup();
      this.options.handlers.final?.(message.text, message.truncated);
    } else {
      this.fail(message.error.message);
    }
  }

  private fail(message: string): void {
    if (!this.active) return;
    this.emit("error");
    this.cleanup();
    this.options.handlers.error?.(message, this.partialText);
  }

  private emit(state: SpeechState): void {
    this.current = state;
    this.options.handlers.state?.(state);
  }

  private cleanup(): void {
    clearTimeout(this.finalTimer);
    this.options.audio.close();
    this.queue = []; this.queued = 0;
    this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
    if (this.socket.readyState <= OPEN) this.socket.close(1000);
  }
}

function microphoneError(cause: unknown): string {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return t("Microphone access is blocked. Allow it for this site in the browser settings, then try again.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("No microphone was found.");
  return t("Couldn't start the microphone.");
}

/**
 * 麦克风与 worklet。构造函数必须在用户手势里同步调用：iOS 只允许在手势中创建并恢复 AudioContext。
 * 采样率用默认 Context 的（S1-1：指定采样率在 WebKit 上有问题），在 worklet 里重采样。
 */
export class BrowserAudio implements AudioSource {
  private context = new AudioContext();
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private closed = false;
  private flushed?: () => void;

  constructor() { void this.context.resume().catch(() => {}); }

  async start(onFrame: (frame: ArrayBuffer) => void): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    await this.context.audioWorklet.addModule(SPEECH_WORKLET_URL);
    if (this.closed) return;
    const node = new AudioWorkletNode(this.context, SPEECH_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    node.port.onmessage = event => {
      if (event.data instanceof ArrayBuffer) onFrame(event.data);
      else if ((event.data as { type?: string } | null)?.type === "flushed") this.flushed?.();
    };
    // 部分浏览器只在节点接到输出时才调用 process；接一个静音的增益节点，不会播放声音。
    const mute = this.context.createGain();
    mute.gain.value = 0;
    this.context.createMediaStreamSource(stream).connect(node);
    node.connect(mute).connect(this.context.destination);
    this.node = node;
  }

  flush(): Promise<void> {
    const node = this.node;
    if (!node || this.closed) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      this.flushed = () => { clearTimeout(timer); resolve(); };
      node.port.postMessage({ type: "flush" });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream?.getTracks().forEach(track => track.stop());
    this.node?.disconnect();
    void this.context.close().catch(() => {});
  }
}
