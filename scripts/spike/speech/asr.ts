import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";

const sampleRate = 16000;
const bytesPerMs = sampleRate * 2 / 1000;
const frameMs = 100;
const funModel = "fun-asr-realtime";
const volcModel = "volc.seedasr.sauc.duration";
const providers = ["fun-asr", "volcengine"] as const;
type Provider = typeof providers[number];

// This fixed glossary is sent unchanged for every clip in the biased arm.
// Score extra spellings separately because they contain punctuation or IDs.
const glossaryWords = [
  "Lumio", "北极星", "Atlas", "WebSocket", "AudioWorklet", "Project Lantern",
  "青岚计划", "Paper Trail", "SQLite", "Tailscale", "PCM16", "citekey",
];
const otherTerms = ["codex@macsp", "vaswani2017attention", "he2016deep", "brown2020language", "connect-src"];
const hotwords = [...glossaryWords, ...otherTerms];
const terms = hotwords;

type ServerEvent =
  | { type: "ready" }
  | { type: "done"; text?: string }
  | { type: "partial"; text: string }
  | { type: "segment"; start: number; text: string };
type Adapter = {
  url: string | URL;
  headers: Record<string, string>;
  start: string | Uint8Array<ArrayBuffer>;
  finish?: string;
  audio?: (data: Uint8Array, last: boolean) => Uint8Array<ArrayBuffer>;
  parse(value: string | ArrayBuffer): ServerEvent | undefined;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function funASR(url: string, key: string, vocabulary?: string): Adapter {
  const task_id = crypto.randomUUID();
  return {
    url,
    headers: { Authorization: "Bearer " + key },
    start: JSON.stringify({
      header: { action: "run-task", task_id, streaming: "duplex" },
      payload: {
        task_group: "audio", task: "asr", function: "recognition", model: funModel,
        parameters: { format: "pcm", sample_rate: sampleRate, ...(vocabulary ? { vocabulary_id: vocabulary } : {}) },
        input: {},
      },
    }),
    finish: JSON.stringify({ header: { action: "finish-task", task_id, streaming: "duplex" }, payload: { input: {} } }),
    parse(value) {
      if (typeof value !== "string") throw new Error("expected Fun-ASR JSON frame");
      const { header, payload } = object(JSON.parse(value));
      const event = object(header);
      if (event.task_id !== task_id) throw new Error("unexpected Fun-ASR task ID");
      if (event.event === "task-started") return { type: "ready" };
      if (event.event === "task-finished") return { type: "done" };
      if (event.event === "task-failed") {
        const code = String(event.error_code);
        throw new Error("Fun-ASR task-failed: " + (/^[A-Za-z0-9_-]{1,50}$/.test(code) ? code : "unknown"));
      }
      if (event.event !== "result-generated") return;
      const sentence = object(object(object(payload).output).sentence);
      if (sentence.heartbeat || typeof sentence.text !== "string" || !sentence.text.trim()) return;
      if (!sentence.sentence_end) return { type: "partial", text: sentence.text };
      if (typeof sentence.begin_time !== "number") throw new Error("missing Fun-ASR segment time");
      return { type: "segment", start: sentence.begin_time, text: sentence.text };
    },
  };
}

const encode = new TextEncoder();
const decode = new TextDecoder();

function volcFrame(type: number, json: boolean, sequence: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const compressed = Bun.gzipSync(Uint8Array.from(payload));
  const frame = new Uint8Array(12 + compressed.length);
  frame.set([0x11, (type << 4) | (sequence < 0 ? 3 : 1), json ? 0x11 : 0x01, 0]);
  const view = new DataView(frame.buffer);
  view.setInt32(4, sequence);
  view.setUint32(8, compressed.length);
  frame.set(compressed, 12);
  return frame;
}

function volcResponse(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  const view = new DataView(value);
  if (bytes.length < 8 || bytes[0]! >> 4 !== 1) throw new Error("invalid Volcengine response header");
  let offset = (bytes[0]! & 15) * 4;
  const type = bytes[1]! >> 4;
  const flags = bytes[1]! & 15;
  const compression = bytes[2]! & 15;
  if (offset < 4 || (type !== 9 && type !== 15) || compression > 1) throw new Error("unsupported Volcengine response");
  if (flags & 1) offset += 4; // sequence
  if (flags & 4) offset += 4; // event
  if (type === 15) throw new Error("Volcengine error code " + view.getUint32(offset));
  const size = view.getUint32(offset);
  const payload = bytes.subarray(offset + 4);
  if (payload.length !== size) throw new Error("invalid Volcengine response length");
  const content = size ? object(JSON.parse(decode.decode(compression ? Bun.gunzipSync(payload) : payload))) : {};
  return { last: Boolean(flags & 2), content };
}

function volcengine(url: string, key: string, biased: boolean): Adapter {
  let sequence = 1;
  let text = "";
  let ready = false;
  return {
    url,
    headers: {
      "X-Api-Key": key, "X-Api-Resource-Id": volcModel, "X-Api-Request-Id": crypto.randomUUID(),
    },
    start: volcFrame(1, true, sequence, encode.encode(JSON.stringify({
      user: { uid: "lumio-spike" },
      audio: { format: "pcm", codec: "raw", rate: sampleRate, bits: 16, channel: 1 },
      request: {
        model_name: "bigmodel", enable_nonstream: false,
        show_utterances: true, result_type: "full",
        ...(biased ? { corpus: { context: JSON.stringify({ hotwords: hotwords.map(word => ({ word })) }) } } : {}),
      },
    }))),
    audio(data, last) {
      sequence++;
      return volcFrame(2, false, last ? -sequence : sequence, data);
    },
    parse(value) {
      if (typeof value === "string") throw new Error("expected Volcengine binary response");
      const { last, content } = volcResponse(value);
      const result = object(content.result);
      if (typeof result.text === "string") text = result.text;
      if (last) return { type: "done", text };
      if (!ready) {
        ready = true;
        return { type: "ready" };
      }
      if (!text || typeof result.text !== "string" || !result.text.trim()) return;
      const utterances = Array.isArray(result.utterances) ? result.utterances.map(object) : [];
      if (!utterances.length || utterances.some(item => !item.definite)) return { type: "partial", text };
      return { type: "segment", start: 0, text };
    },
  };
}

function transcribe(adapter: Adapter, pcm: Uint8Array, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const started = performance.now();
  let readyAt: number | undefined;
  let firstAudioAt: number | undefined;
  let releaseAt: number | undefined;
  let firstPartialAt: number | undefined;
  let lastSegmentAt: number | undefined;
  let stopped = false;
  const segments = new Map<number, string>();

  return new Promise<{
    text: string; setupMs: number; firstPartialMs: number | null;
    releaseToFinalMs: number; releaseToLastSegmentMs: number | null; audioMs: number;
  }>((resolve, reject) => {
    const ws = new WebSocket(adapter.url, { headers: adapter.headers });
    ws.binaryType = "arraybuffer";
    const timeout = setTimeout(() => fail(new Error("ASR session timeout")), pcm.length / bytesPerMs + 20000);
    const abort = () => fail(signal!.reason as Error);
    signal?.addEventListener("abort", abort, { once: true });
    function stop() {
      stopped = true;
      signal?.removeEventListener("abort", abort);
      clearTimeout(timeout);
      if (ws.readyState < WebSocket.CLOSING) ws.close();
    }
    function fail(error: Error) {
      if (stopped) return;
      stop();
      reject(error);
    }
    async function sendAudio() {
      readyAt = performance.now();
      for (let offset = 0; offset < pcm.length; offset += frameMs * bytesPerMs) {
        const end = Math.min(offset + frameMs * bytesPerMs, pcm.length);
        // The first frame becomes available one frame interval after simulated press.
        const delay = readyAt + end / bytesPerMs - performance.now();
        if (delay > 0) await Bun.sleep(delay);
        if (stopped) return;
        if (ws.bufferedAmount > 65536) throw new Error("ASR WebSocket backpressure");
        firstAudioAt ??= performance.now();
        const last = end === pcm.length;
        const data = pcm.subarray(offset, end);
        const frame = adapter.audio?.(data, last) ?? data;
        if (last && adapter.finish === undefined) releaseAt = performance.now();
        ws.send(frame);
      }
      if (adapter.finish !== undefined) {
        releaseAt = performance.now();
        ws.send(adapter.finish);
      }
    }
    ws.onopen = () => ws.send(adapter.start);
    ws.onerror = () => fail(new Error("WebSocket connection error (check region, credentials and network)"));
    ws.onclose = event => fail(new Error("WebSocket closed before terminal event, code " + event.code));
    ws.onmessage = event => {
      if (stopped) return;
      const receivedAt = performance.now();
      try {
        const result = adapter.parse(event.data);
        if (result?.type === "ready" && readyAt === undefined) void sendAudio().catch(fail);
        if (result?.type === "partial" && firstAudioAt !== undefined && releaseAt === undefined) firstPartialAt ??= receivedAt;
        if (result?.type === "segment") {
          if (segments.get(result.start) !== result.text) lastSegmentAt = receivedAt;
          segments.set(result.start, result.text);
        }
        if (result?.type !== "done") return;
        if (readyAt === undefined || releaseAt === undefined) throw new Error("ASR completed before release");
        const text = result.text ?? [...segments].sort(([a], [b]) => a - b).map(([, value]) => value).join(" ");
        stop();
        resolve({
          text, setupMs: readyAt - started,
          firstPartialMs: firstPartialAt === undefined ? null : firstPartialAt - readyAt,
          releaseToFinalMs: receivedAt - releaseAt,
          releaseToLastSegmentMs: result.text && segments.get(0) !== result.text
            ? receivedAt - releaseAt : lastSegmentAt === undefined ? null : Math.max(0, lastSegmentAt - releaseAt),
          audioMs: pcm.length / bytesPerMs,
        });
      } catch (error) {
        fail(error instanceof SyntaxError ? new Error("invalid ASR JSON") : error as Error);
      }
    };
  });
}

const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
const characters = (text: string) => [...normalize(text).replace(/[^\p{L}\p{N}]/gu, "")];

function distance(expected: string[], actual: string[]) {
  let previous = actual.map((_, index) => index + 1);
  previous.unshift(0);
  for (const [index, letter] of expected.entries()) {
    const row = [index + 1];
    for (const [column, other] of actual.entries()) {
      row.push(Math.min(row[column]! + 1, previous[column + 1]! + 1, previous[column]! + Number(letter !== other)));
    }
    previous = row;
  }
  return previous[actual.length]!;
}

const words = (text: string) => normalize(text).match(/\p{Script=Han}|[a-z0-9]+(?:[@-][a-z0-9]+)*/gu) ?? [];

function occurrences(transcript: string, term: string) {
  const tokens = words(transcript);
  const target = words(term);
  return tokens.filter((_, index) => target.every((word, offset) => tokens[index + offset] === word)).length;
}

function score(reference: string, text: string) {
  const expected = characters(reference);
  const counts = terms.map(term => {
    const targets = occurrences(reference, term);
    const seen = occurrences(text, term);
    return { term, targets, hits: Math.min(targets, seen), extras: Math.max(0, seen - targets) };
  });
  return { errors: distance(expected, characters(text)), referenceChars: expected.length, counts };
}

function percentiles(values: number[]) {
  values.sort((a, b) => a - b);
  const quantile = (p: number) => values.length ? Math.round(values[Math.ceil(p * values.length) - 1]!) : null;
  return { n: values.length, p50: quantile(0.5), p95: quantile(0.95) };
}

type Measurement = Awaited<ReturnType<typeof transcribe>>;
type Result = { id: string; provider: Provider; biased: boolean } & Omit<Measurement, "text"> & ReturnType<typeof score>;

function summary(results: Result[]) {
  const sum = (select: (result: Result) => number) => results.reduce((total, result) => total + select(result), 0);
  const perTerm = terms.map((term, index) => ({
    term,
    hits: sum(result => result.counts[index]!.hits),
    targets: sum(result => result.counts[index]!.targets),
    extras: sum(result => result.counts[index]!.extras),
  }));
  const totals = (selected: string[]) => perTerm.filter(row => selected.includes(row.term)).reduce((total, row) => ({
    hits: total.hits + row.hits, targets: total.targets + row.targets, extras: total.extras + row.extras,
  }), { hits: 0, targets: 0, extras: 0 });
  return {
    clips: results.length, audioSeconds: sum(row => row.audioMs) / 1000,
    edits: sum(row => row.errors), referenceChars: sum(row => row.referenceChars),
    cer: results.length ? sum(row => row.errors) / sum(row => row.referenceChars) : null,
    glossary: totals(glossaryWords), otherTerms: totals(otherTerms), perTerm,
    setupMs: percentiles(results.map(row => row.setupMs)),
    firstPartialMs: percentiles(results.flatMap(row => row.firstPartialMs === null ? [] : [row.firstPartialMs])),
    releaseToFinalMs: percentiles(results.map(row => row.releaseToFinalMs)),
    releaseToLastSegmentMs: percentiles(results.flatMap(row => row.releaseToLastSegmentMs === null ? [] : [row.releaseToLastSegmentMs])),
  };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing environment variable " + name);
  return value;
}

function verifySignal(pcm: Uint8Array, id: string) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const blockSamples = 320; // 20 ms at 16 kHz
  let peak = 0;
  let loudBlocks = 0;
  for (let offset = 0; offset + blockSamples * 2 <= view.byteLength; offset += blockSamples * 2) {
    let energy = 0;
    for (let sample = 0; sample < blockSamples; sample++) {
      const value = view.getInt16(offset + sample * 2, true);
      peak = Math.max(peak, Math.abs(value));
      energy += value * value;
    }
    if (energy >= blockSamples * 104 ** 2) loudBlocks++;
  }
  if (pcm.byteLength < 500 * bytesPerMs || peak < 260 || loudBlocks < 5) {
    throw new Error("WAV is too short, silent, or below the recording level threshold: " + id);
  }
}

async function readClips(dir: string) {
  const rows = (await Bun.file(join(dir, "transcripts.tsv")).text()).trim().split(/\r?\n/);
  const clips = [];
  for (const [index, row] of rows.entries()) {
    const [id, reference, ...extra] = row.split("\t");
    if (id !== String(index + 1).padStart(2, "0") || !reference || !characters(reference).length || extra.length) {
      throw new Error("invalid transcripts.tsv row " + (index + 1));
    }
    const filename = join(dir, id + ".wav");
    if (!await Bun.file(filename).exists()) throw new Error("missing WAV " + id);
    const result = Bun.spawnSync({
      cmd: ["ffmpeg", "-nostdin", "-v", "error", "-i", filename, "-t", "121", "-map", "0:a:0",
        "-ar", String(sampleRate), "-ac", "1", "-f", "s16le", "pipe:1"],
      stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode || !result.stdout.length || result.stdout.length > 120000 * bytesPerMs) {
      throw new Error("invalid WAV or duration exceeds 120s: " + id);
    }
    verifySignal(result.stdout, id);
    clips.push({ id, reference, pcm: result.stdout });
  }
  if (clips.length !== 20) throw new Error("expected all 20 recorded clips");
  return clips;
}

function dashscope() {
  const key = env("DASHSCOPE_API_KEY");
  const region = env("DASHSCOPE_REGION");
  if (region !== "singapore" && region !== "beijing") throw new Error("DASHSCOPE_REGION must be singapore or beijing");
  const workspace = env("DASHSCOPE_WORKSPACE_ID");
  if (!/^[a-z0-9-]+$/.test(workspace)) throw new Error("invalid DashScope workspace ID");
  const host = workspace + "." + (region === "singapore" ? "ap-southeast-1" : "cn-beijing") + ".maas.aliyuncs.com";
  async function vocabulary(action: string, parameters: object) {
    const response = await fetch("https://" + host + "/api/v1/services/audio/asr/customization", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "speech-biasing", input: { action, ...parameters } }),
    });
    if (!response.ok) throw new Error("DashScope " + action + " HTTP " + response.status);
    return object(object(await response.json()).output);
  }
  return { region, vocabulary, adapter: (id?: string) => funASR("wss://" + host + "/api-ws/v1/inference", key, id) };
}

async function run(dir: string, selected: readonly Provider[], hotwordsOnly = false) {
  const clips = await readClips(dir);
  const dash = selected.includes("fun-asr") ? dashscope() : undefined;
  const volcKey = selected.includes("volcengine") ? env("VOLCENGINE_SPEECH_API_KEY") : undefined;
  let vocabularyId: string | undefined;
  const rows: Result[] = [];
  const failures: { id: string; provider: Provider; biased: boolean; error: string }[] = [];
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("ASR benchmark interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (dash) {
      const created = await dash.vocabulary("create_vocabulary", {
        target_model: funModel, prefix: "lms1" + crypto.randomUUID().slice(0, 6),
        vocabulary: hotwords.map(text => ({ text, weight: 4, lang: /\p{Script=Han}/u.test(text) ? "zh" : "en" })),
      });
      if (typeof created.vocabulary_id !== "string") throw new Error("DashScope did not return a vocabulary ID");
      vocabularyId = created.vocabulary_id;
      const deadline = performance.now() + 60000;
      while ((await dash.vocabulary("query_vocabulary", { vocabulary_id: vocabularyId })).status !== "OK") {
        controller.signal.throwIfAborted();
        if (performance.now() >= deadline) throw new Error("DashScope vocabulary did not become ready");
        await Bun.sleep(1000);
      }
    }
    for (const [index, clip] of clips.entries()) {
      const order = index % 2 ? [...selected].reverse() : selected;
      for (const provider of order) {
        for (const biased of hotwordsOnly ? [true] : index % 2 ? [true, false] : [false, true]) {
          const adapter = provider === "fun-asr" ? dash!.adapter(biased ? vocabularyId : undefined)
            : volcengine("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async", volcKey!, biased);
          try {
            const { text, ...timings } = await transcribe(adapter, clip.pcm, controller.signal);
            rows.push({ id: clip.id, provider, biased, ...timings, ...score(clip.reference, text) });
          } catch (error) {
            controller.signal.throwIfAborted();
            failures.push({ id: clip.id, provider, biased, error: (error as Error).message });
          }
        }
      }
      console.error("ASR clips processed: " + (index + 1) + "/" + clips.length);
    }
  } finally {
    if (dash && vocabularyId) {
      await dash.vocabulary("delete_vocabulary", { vocabulary_id: vocabularyId }).catch(() => {
        console.error("DashScope cleanup failed; remove vocabulary ID " + vocabularyId + " from your workspace.");
        process.exitCode = 1;
      });
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  console.log(JSON.stringify({
    time: new Date().toISOString(), bun: Bun.version, frameMs, hotwords, hotwordsOnly,
    models: { "fun-asr": funModel, volcengine: volcModel }, dashscopeRegion: dash?.region,
    summary: selected.flatMap(provider => (hotwordsOnly ? [true] : [false, true]).map(biased => ({
      provider, biased, ...summary(rows.filter(row => row.provider === provider && row.biased === biased)),
    }))),
    failures, clips: rows,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

async function smoke() {
  const fixture = "Lumio 和 SQLite 交给 codex@macsp";
  const pcm = new Uint8Array(bytesPerMs * 240);
  const samples = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length / 2; i++) samples.setInt16(i * 2, Math.sin(i * 0.17) * 8192, true);
  verifySignal(new Uint8Array(bytesPerMs * 600).map((_, index) => pcm[index % pcm.length]!), "synthetic");
  assert.throws(() => verifySignal(new Uint8Array(bytesPerMs * 600), "silent"), /silent/);
  const mock = Bun.serve<{ volcengine: boolean; id: string; bytes: number }>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (server.upgrade(request, { data: { volcengine: path === "/volc", id: "", bytes: 0 } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, message) {
        if (ws.data.volcengine) {
          assert(Buffer.isBuffer(message));
          const type = message[1]! >> 4;
          const sequence = message.readInt32BE(4);
          const payload = Bun.gunzipSync(message.subarray(12));
          const send = (body: object, seq: number) => ws.send(volcFrame(9, true, seq, encode.encode(JSON.stringify(body))));
          if (type === 1) {
            assert.equal(sequence, 1);
            const request = JSON.parse(decode.decode(payload)).request;
            assert.equal(request.enable_nonstream, false);
            assert.deepEqual(JSON.parse(request.corpus.context).hotwords, hotwords.map(word => ({ word })));
            send({}, 1);
          } else {
            assert.equal(type, 2);
            ws.data.bytes += payload.length;
            if (sequence === 2) send({ result: { text: "Lumio" } }, 2);
            if (sequence < 0) {
              assert.equal(ws.data.bytes, pcm.length);
              send({ result: { text: fixture } }, sequence);
            }
          }
          return;
        }
        const funEvent = (event: string, payload?: object) => ws.send(JSON.stringify({
          header: { event, task_id: ws.data.id }, payload,
        }));
        const result = (final: boolean, text: string) => funEvent("result-generated", {
          output: { sentence: { text, begin_time: 0, sentence_end: final } },
        });
        if (typeof message !== "string") {
          ws.data.bytes += message.length;
          if (ws.data.bytes === frameMs * bytesPerMs) result(false, "Lumio");
          return;
        }
        const control = JSON.parse(message);
        if (control.header?.action === "run-task") {
          ws.data.id = control.header.task_id;
          funEvent("task-started");
        } else {
          assert.equal(ws.data.bytes, pcm.length);
          result(true, fixture);
          funEvent("task-finished");
        }
      },
    },
  });
  try {
    const url = "ws://127.0.0.1:" + mock.port;
    for (const adapter of [funASR(url, "synthetic"), volcengine(url + "/volc", "synthetic", true)]) {
      const result = await transcribe(adapter, pcm);
      assert.equal(result.text, fixture);
      assert(result.firstPartialMs !== null && result.firstPartialMs >= 80);
      assert.equal(result.audioMs, 240);
    }
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(new Error("synthetic abort")), 20);
    try {
      await assert.rejects(transcribe(funASR(url, "synthetic"), pcm, controller.signal), /synthetic abort/);
    } finally {
      clearTimeout(abortTimer);
    }
    assert.equal(score(fixture, fixture).errors, 0);
    assert.equal(occurrences(fixture, "codex@macsp"), 1);
    assert.equal(occurrences(fixture.replace("@", " "), "codex@macsp"), 0);
    assert.equal(score("Lumio", "Lumio SQLite").errors, 6);
    console.log("OK: synthetic PCM, both mock WebSocket protocols, timings and scoring");
  } finally {
    await mock.stop(true);
  }
}

try {
  const [first, second, option, ...rest] = Bun.argv.slice(2);
  if (first === "--smoke" && !second) await smoke();
  else if (first === "--help") console.log("bun asr.ts [testset-dir] [fun-asr|volcengine] [--hotwords-only]\nbun asr.ts --validate [testset-dir]\nbun asr.ts --smoke");
  else if (first === "--validate" && !option && !rest.length) {
    const clips = await readClips(second ?? join(homedir(), "lumio-speech-testset"));
    console.log(clips.length + " clips passed local audio checks");
  }
  else {
    if (rest.length || (option && option !== "--hotwords-only") || (second && !providers.includes(second as Provider))) throw new Error("see --help");
    await run(first ?? join(homedir(), "lumio-speech-testset"), second ? [second as Provider] : providers, option === "--hotwords-only");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "ASR benchmark failed");
  process.exitCode = 1;
}
