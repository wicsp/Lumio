/**
 * 语音采集的 AudioWorklet（ADR 0055，S1-4）：在音频线程里把麦克风输入混成单声道、低通、重采样到 16 kHz，
 * 按 40 ms（640 个样本）打包成小端 PCM16 帧，经 MessagePort 转移给主线程。
 * CSP 只允许同源脚本，worklet 不能用 blob: 加载，所以和 service worker 一样以字符串形式由 Hub 提供（/assets/speech-worklet.js）。
 *
 * 主线程消息：{ type: "flush" } → 送出最后不足一帧的样本，再回 { type: "flushed" }，之后处理器停止。
 * 处理器消息：ArrayBuffer（一帧 PCM16LE）| { type: "flushed" }。
 */
export const SPEECH_WORKLET_NAME = "lumio-speech-capture";

export const SPEECH_WORKLET = `"use strict";
const OUT_RATE = 16000;
const FRAME = 640;
const TAPS = 63;

function lowpass(inRate) {
  const cutoff = Math.min(7200, inRate / 2 * 0.9) / inRate;
  const taps = new Float32Array(TAPS);
  const mid = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (TAPS - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (TAPS - 1));
    taps[i] = sinc * blackman;
    sum += taps[i];
  }
  for (let i = 0; i < TAPS; i++) taps[i] /= sum;
  return taps;
}

class Resampler {
  constructor(inRate) {
    this.step = inRate / OUT_RATE;
    this.taps = inRate > OUT_RATE ? lowpass(inRate) : null;
    this.history = new Float32Array(TAPS - 1);
    this.previous = 0;
    this.position = 0;
    this.frame = new Int16Array(FRAME);
    this.filled = 0;
  }

  filter(input) {
    if (!this.taps) return input;
    const keep = TAPS - 1;
    const all = new Float32Array(keep + input.length);
    all.set(this.history);
    all.set(input, keep);
    const output = new Float32Array(input.length);
    for (let n = 0; n < input.length; n++) {
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += this.taps[k] * all[n + keep - k];
      output[n] = acc;
    }
    this.history = all.slice(all.length - keep);
    return output;
  }

  emit(sample, frames) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.frame[this.filled++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    if (this.filled === FRAME) {
      frames.push(this.frame);
      this.frame = new Int16Array(FRAME);
      this.filled = 0;
    }
  }

  push(input) {
    const frames = [];
    if (!input.length) return frames;
    const y = this.filter(input);
    const last = y.length - 1;
    while (this.position <= last) {
      const i = Math.floor(this.position);
      const frac = this.position - i;
      const a = i < 0 ? this.previous : y[i];
      const value = frac === 0 ? a : a + (y[i + 1] - a) * frac;
      this.emit(value, frames);
      this.position += this.step;
    }
    this.position -= y.length;
    this.previous = y[last];
    return frames;
  }

  flush() {
    if (!this.filled) return [];
    const tail = this.frame.slice(0, this.filled);
    this.frame = new Int16Array(FRAME);
    this.filled = 0;
    return [tail];
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("${SPEECH_WORKLET_NAME}", class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.resampler = new Resampler(sampleRate);
      this.done = false;
      this.port.onmessage = (event) => {
        if (!event.data || event.data.type !== "flush" || this.done) return;
        for (const frame of this.resampler.flush()) this.port.postMessage(frame.buffer, [frame.buffer]);
        this.done = true;
        this.port.postMessage({ type: "flushed" });
      };
    }
    process(inputs) {
      if (this.done) return false;
      const channels = inputs[0];
      if (channels && channels.length && channels[0].length) {
        const length = channels[0].length;
        const mono = new Float32Array(length);
        for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
        for (const frame of this.resampler.push(mono)) this.port.postMessage(frame.buffer, [frame.buffer]);
      }
      return true;
    }
  });
}
`;
