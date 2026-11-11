// Low-pass before decimation. Keep filter history and fractional source
// position across variable-size render quanta.
const rate = 16000;
const frameSize = 640;
const half = 32;

class PCMProbe extends AudioWorkletProcessor {
  constructor() {
    super();
    this.input = Array(half).fill(0);
    this.position = half;
    this.step = sampleRate / rate;
    this.cutoff = 0.45 * Math.min(1, rate / sampleRate);
    this.frame = new DataView(new ArrayBuffer(frameSize * 2));
    this.count = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      const mono = channels.reduce((sum, channel) => sum + channel[index], 0) / channels.length;
      this.input.push(mono);
    }

    while (this.position + half < this.input.length) {
      const center = Math.floor(this.position);
      let filtered = 0;
      let weights = 0;
      for (let offset = -half + 1; offset <= half; offset++) {
        const distance = center + offset - this.position;
        const x = 2 * this.cutoff * distance;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / half);
        const weight = sinc * window;
        filtered += this.input[center + offset] * weight;
        weights += weight;
      }
      const sample = Math.max(-1, Math.min(1, filtered / weights));
      this.frame.setInt16(this.count * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      this.count++;
      this.position += this.step;
      if (this.count === frameSize) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new DataView(new ArrayBuffer(frameSize * 2));
        this.count = 0;
      }
    }

    const discard = Math.floor(this.position) - half;
    this.input.splice(0, discard);
    this.position -= discard;
    return true;
  }
}
registerProcessor("pcm-probe", PCMProbe);
