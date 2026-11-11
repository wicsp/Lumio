/**
 * 输入框旁的麦克风（ADR 0055，S1-4）。按住说话，松开定稿；点一下开始、再点一下结束；Esc 取消。
 * 识别文字插入光标位置，不覆盖已有内容，不自动发送。同一时间只有一个输入框在录音。
 *
 * 入口只在三件事都满足时出现：浏览器能录音（安全上下文）、已登录、已绑定 speech.asr 用途。
 */
import type { SpeechBinding } from "@lumio/schema";
import type { Session } from "./api.ts";
import { h, icon, setPromptSpeech, toast } from "./dom.ts";
import { t } from "./i18n.ts";
import { BrowserAudio, SpeechSession, speechSupported, type AudioSource } from "./speech.ts";

/** 按住超过这个时长松开算"按住说话"，否则算点按开关。 */
const HOLD_MS = 350;

type Field = HTMLTextAreaElement | HTMLInputElement;

/** 在 [start, end) 处插入文字；返回新值与插入后的光标位置。 */
export function insertText(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  return { value: value.slice(0, from) + text + value.slice(to), caret: from + text.length };
}

export type SpeechAvailability = "unsupported" | "insecure" | "unbound" | "ready";

/** 本次登录内的语音入口状态；设置页改了绑定后调用 refresh()。 */
export class SpeechService {
  private bindings: SpeechBinding[] = [];
  private listeners = new Set<() => void>();
  private loaded = false;
  active?: { session: SpeechSession; owner: Field; finish(cancel: boolean): void };

  constructor(readonly session: Session, private readonly audio: () => AudioSource = () => new BrowserAudio()) {
    void this.refresh();
    // 页面隐藏时定稿已说的部分并释放麦克风（S1-1：iOS 后台会中断音频与 WebSocket）。
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onHidden);
  }

  private readonly onHidden = () => { if (document.visibilityState === "hidden") this.active?.finish(false); };

  dispose(): void {
    this.active?.finish(true);
    this.listeners.clear();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onHidden);
  }

  availability(): SpeechAvailability {
    if (typeof window !== "undefined" && !window.isSecureContext) return "insecure";
    if (!speechSupported() || !this.session.token) return "unsupported";
    return this.bindings.some(binding => binding.purpose === "speech.asr") ? "ready" : "unbound";
  }

  get ready(): boolean { return this.loaded && this.availability() === "ready"; }

  async refresh(): Promise<void> {
    try { this.bindings = await this.session.hub.speechBindings(); }
    catch { this.bindings = []; }
    this.loaded = true;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 在用户手势里同步调用（iOS 只允许在手势中启动音频）。 */
  record(owner: Field, handlers: ConstructorParameters<typeof SpeechSession>[0]["handlers"]): SpeechSession | undefined {
    if (!this.ready || !this.session.token) return undefined;
    this.active?.finish(true);
    return new SpeechSession({ token: this.session.token, audio: this.audio(), handlers });
  }
}

let service: SpeechService | undefined;

/** 由工作台在登录后设置、登出时清除。 */
export function setSpeechService(next: SpeechService | undefined): void {
  if (service !== next) service?.dispose();
  service = next;
  setPromptSpeech(next ? speechButton : undefined);
}
export function speechService(): SpeechService | undefined { return service; }

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/**
 * 给输入框配一个麦克风按钮。没有语音服务或不可用时按钮隐藏。
 * 返回的元素放在输入框所在的工具栏里；状态条（计时与临时文字）插在按钮前。
 */
export function speechButton(field: Field): HTMLElement {
  const live = h("span", { class: "speech-live", role: "status", "aria-live": "polite", hidden: true });
  const button = h("button", { type: "button", class: "icon-btn speech-btn", title: t("Hold to talk, or click to start and stop · Esc cancels"), "aria-label": t("Voice input"), "aria-pressed": "false" }, icon("mic"));
  const wrap = h("span", { class: "speech-input", hidden: true }, live, button);
  let current: SpeechSession | undefined;
  let pressed = 0;
  let started = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let range = { start: 0, end: 0 };

  const render = () => {
    const owner = service;
    wrap.hidden = !owner?.ready;
  };
  let unsubscribe = service?.subscribe(render);
  render();
  // 输入框被移出页面后释放订阅与录音。
  const observer = new MutationObserver(() => { if (!wrap.isConnected && !field.isConnected) dispose(); });
  queueMicrotask(() => { if (document.body) observer.observe(document.body, { childList: true, subtree: true }); });

  const showLive = (text: string) => {
    live.hidden = false;
    live.textContent = `${clock(Date.now() - started)}  ${text || t("Listening…")}`;
  };

  const finish = (cancel: boolean) => {
    if (!current) return;
    const session = current;
    if (cancel) session.cancel(); else void session.stop();
  };

  const reset = () => {
    clearInterval(ticker); ticker = undefined;
    current = undefined;
    if (service?.active?.owner === field) service.active = undefined;
    button.classList.remove("is-recording", "is-finishing");
    button.setAttribute("aria-pressed", "false");
    live.hidden = true; live.textContent = "";
    document.removeEventListener("keydown", onEscape, true);
  };

  const insert = (text: string) => {
    if (!text || !field.isConnected) return;
    const next = insertText(field.value, range.start, range.end, text);
    field.value = next.value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus();
    field.setSelectionRange(next.caret, next.caret);
  };

  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !current) return;
    event.preventDefault(); event.stopPropagation();
    finish(true);
  };

  const start = () => {
    const owner = service;
    if (!owner?.ready) return;
    range = { start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length };
    started = Date.now();
    current = owner.record(field, {
      state: state => {
        if (state === "finishing") { button.classList.add("is-finishing"); showLive(live.dataset.partial ?? ""); }
        if (state === "done" || state === "cancelled" || state === "error") reset();
      },
      partial: text => { live.dataset.partial = text; showLive(text); },
      final: (text, truncated) => {
        insert(text);
        if (truncated) toast(t("Speech input stopped at the time limit. What was heard so far was inserted."));
      },
      error: (message, partial) => { insert(partial); toast(message, "error"); },
    });
    if (!current) return;
    owner.active = { session: current, owner: field, finish };
    delete live.dataset.partial;
    button.classList.add("is-recording");
    button.setAttribute("aria-pressed", "true");
    showLive("");
    ticker = setInterval(() => showLive(live.dataset.partial ?? ""), 500);
    document.addEventListener("keydown", onEscape, true);
  };

  button.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault(); // 保留输入框的焦点与光标。
    if (current) { finish(false); return; }
    pressed = Date.now();
    start();
  });
  button.addEventListener("pointerup", () => {
    if (current && pressed && Date.now() - pressed >= HOLD_MS) finish(false);
    pressed = 0;
  });
  button.addEventListener("pointercancel", () => { pressed = 0; });
  // 键盘：Enter / 空格切换。
  button.addEventListener("click", event => {
    if (event.detail !== 0) return;
    if (current) finish(false); else start();
  });

  function dispose() {
    finish(true);
    unsubscribe?.(); unsubscribe = undefined;
    observer.disconnect();
  }

  return wrap;
}

/** 手柄 RT（G1-4）：对当前焦点所在输入框旁的麦克风按下 / 松开。 */
export function speechKey(phase: "press" | "release", field: Element | null): boolean {
  const button = field?.closest("form, .composer, .attn-composer, .form-stack")?.querySelector<HTMLButtonElement>(".speech-input:not([hidden]) .speech-btn");
  if (!button) return false;
  button.dispatchEvent(new PointerEvent(phase === "press" ? "pointerdown" : "pointerup", { button: 0, bubbles: true }));
  return true;
}
