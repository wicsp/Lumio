const route = "/v2/speech/transcribe";
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const sameOrigin = protocol + "//" + location.host + route;
const peerPort = document.querySelector("meta[name=speech-peer]").content;
const crossOrigin = protocol + "//" + location.hostname + ":" + peerPort + route;
const output = document.querySelector("#audio");

function checkSocket(url) {
  return new Promise(resolve => {
    let socket;
    let violation = false;
    const onViolation = event => {
      if (event.effectiveDirective === "connect-src") violation = true;
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    const finish = result => {
      clearTimeout(timer);
      document.removeEventListener("securitypolicyviolation", onViolation);
      socket?.close();
      resolve({ result, violation });
    };
    const timer = setTimeout(() => finish("timeout"), 4000);
    try {
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => socket.send(JSON.stringify({ type: "start" }));
      socket.onmessage = event => {
        if (event.data === "ready") socket.send(new Uint8Array([0, 128, 255, 127]));
        else finish(String(new Uint8Array(event.data)) === "0,128,255,127" ? "echo" : "bad echo");
      };
      socket.onerror = () => setTimeout(() => finish("error"), 250);
    } catch {
      setTimeout(() => finish("error"), 250);
    }
  });
}

(async () => {
  const same = await checkSocket(sameOrigin);
  const cross = await checkSocket(crossOrigin);
  document.querySelector("#socket").textContent = JSON.stringify({
    same, cross, secureContext: isSecureContext, standalone: matchMedia("(display-mode: standalone)").matches,
    userAgent: navigator.userAgent,
  }, null, 2);
})();

async function capture(kind, context) {
  let stream;
  try {
    let track = null;
    if (kind === "mic") {
      const resumed = context.resume();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      track = stream.getAudioTracks()[0];
      let timeout;
      try {
        await Promise.race([resumed, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("AudioContext did not resume")), 6000);
        })]);
      } finally {
        clearTimeout(timeout);
      }
    }
    let moduleTimeout;
    try {
      await Promise.race([context.audioWorklet.addModule("/pcm-worklet.js"), new Promise((_, reject) => {
        moduleTimeout = setTimeout(() => reject(new Error("AudioWorklet module load timed out")), 6000);
      })]);
    } finally {
      clearTimeout(moduleTimeout);
    }
    const node = new AudioWorkletNode(context, "pcm-probe");
    const values = [];
    let frameCount = 0;
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PCM frames timed out (" + context.sampleRate + " Hz, " + frameCount + " frames)")), 10000);
      node.onprocessorerror = () => {
        clearTimeout(timer);
        reject(new Error("AudioWorklet processor failed at " + context.sampleRate + " Hz"));
      };
      node.port.onmessage = ({ data }) => {
        if (data.byteLength !== 1280) {
          clearTimeout(timer);
          reject(new Error("Unexpected frame length"));
          return;
        }
        const view = new DataView(data);
        for (let i = 0; i < view.byteLength; i += 2) values.push(view.getInt16(i, true));
        if (++frameCount === 50) {
          node.port.onmessage = null;
          clearTimeout(timer);
          resolve();
        }
      };
    });
    node.connect(context.destination); // Processor emits silence, so the microphone isn't played back.
    if (track) {
      context.createMediaStreamSource(stream).connect(node);
    } else {
      for (const frequency of [1000, 10000]) {
        const tone = new OscillatorNode(context, { frequency });
        tone.connect(new GainNode(context, { gain: 0.25 })).connect(node);
        tone.start();
      }
    }
    if (kind === "tone") void context.startRendering().catch(error => console.error(error));
    await done;
    const amplitude = frequency => {
      let sin = 0;
      let cos = 0;
      for (let i = 0; i < values.length; i++) {
        const phase = 2 * Math.PI * frequency * i / 16000;
        sin += values[i] * Math.sin(phase);
        cos += values[i] * Math.cos(phase);
      }
      return 2 * Math.hypot(sin, cos) / values.length / 32768;
    };
    return {
      kind, contextRate: context.sampleRate, trackRate: track?.getSettings().sampleRate ?? null,
      frames: frameCount, bytesPerFrame: 1280, samples: values.length,
      peak: Math.max(...values.map(Math.abs)),
      ...(track ? {} : { tone1k: amplitude(1000), alias6k: amplitude(6000) }),
    };
  } finally {
    stream?.getTracks().forEach(track => track.stop());
    if (kind === "mic") await context.close();
  }
}

async function probe(kind) {
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  output.textContent = "正在采集…";
  try {
    const contexts = kind === "tone"
      ? [44100, 48000].map(sampleRate => new OfflineAudioContext(1, Math.ceil(sampleRate * 2.1), sampleRate))
      : [new AudioContext()];
    const results = [];
    for (const context of contexts) results.push(await capture(kind, context));
    output.textContent = JSON.stringify(results, null, 2);
  } catch (error) {
    output.textContent = String(error);
  } finally {
    for (const button of document.querySelectorAll("button")) button.disabled = false;
  }
}

document.querySelector("#tone").onclick = () => probe("tone");
document.querySelector("#mic").onclick = () => probe("mic");

if (new URLSearchParams(location.search).get("auto") === "tone") void probe("tone");
