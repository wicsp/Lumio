import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/bilibili-transcribe.sh", import.meta.url).pathname;
const fixture = new URL("../../../fixtures/i1-inbox/groq-transcript.json", import.meta.url).pathname;
const testKey = "gsk_SYNTHETIC_TEST_KEY";

test("Bilibili transcriber uses the injected Groq credential and preserves the archive format", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-test-bilibili-groq-"));
  try {
    const tools = join(root, "bin");
    await mkdir(tools);
    const stubs = {
      "yt-dlp": `while [ "$1" != --output ]; do shift; done
        audio="\${2%.*}.m4a"
        if [ "\${TEST_BIG_AUDIO:-}" = yes ]; then
          dd if=/dev/zero of="$audio" bs=1 count=1 seek=25000000 2>/dev/null
        else
          printf audio > "$audio"
        fi
        printf '\"合成 B 站视频\"\\n'`,
      ffmpeg: `printf audio > "\${!#}"`,
      ffprobe: "printf '2.500\\n'",
      curl: `IFS= read -r header
        [ "$header" = "Authorization: Bearer $TEST_KEY" ]
        [[ " $* " != *"$TEST_KEY"* ]]
        [[ " $* " == *' model=whisper-large-v3-turbo '* ]]
        [[ " $* " == *' https://api.groq.com/openai/v1/audio/transcriptions ' ]]
        if [ "\${TEST_BIG_AUDIO:-}" = yes ]; then
          [[ " $* " == *'/groq.m4a '* ]]
        fi
        while [ "$1" != --output ]; do shift; done
        cp "$TEST_RESPONSE" "$2"
        printf '%s' "$TEST_STATUS"`,
      "whisper-cli": `while [ "$1" != -of ]; do shift; done
        printf 'WEBVTT\\n\\n00:00:00.000 --> 00:00:01.250\\n本地合成字幕\\n' > "$2.vtt"`,
    };
    for (const [tool, stub] of Object.entries(stubs)) {
      await writeFile(join(tools, tool), `#!/usr/bin/env bash\nset -eu\n${stub}\n`, { mode: 0o700 });
    }
    const key = join(root, "key"), model = join(root, "model");
    await writeFile(key, `${testKey}\n`, { mode: 0o600 });
    await writeFile(model, "synthetic model");
    function run(overrides: Record<string, string>) {
      const result = Bun.spawnSync(["bash", script, "https://www.bilibili.com/video/BV1xx411c7mD"], {
        env: { ...process.env, HOME: root, TMPDIR: root, PATH: `${tools}:${process.env.PATH}`,
          BILIBILI_COOKIES_FILE: "", BILIBILI_GROQ_API_KEY_FILE: key, WHISPER_CPP_MODEL: model,
          TEST_KEY: testKey, TEST_RESPONSE: fixture, TEST_STATUS: "200", ...overrides },
        stdout: "pipe", stderr: "pipe",
      });
      return { code: result.exitCode, out: result.stdout.toString(), error: result.stderr.toString() };
    }
    expect(run({})).toEqual({ code: 0, error: "", out: [
      "LUMIO-BILIBILI-TRANSCRIPT 1", '"合成 B 站视频"', "WEBVTT", "",
      "00:00:00.000 --> 00:00:01.250", "合成字幕 第一句", "",
      "00:00:01.500 --> 00:00:02.500", "合成字幕第二句", "",
    ].join("\n") });
    expect(run({ TEST_BIG_AUDIO: "yes" })).toEqual(run({}));
    expect(run({ TEST_STATUS: "429" })).toEqual({ code: 1, out: "", error: "Groq transcription failed (HTTP 429).\n" });
    expect(run({ BILIBILI_GROQ_API_KEY_FILE: "" }).out).toContain("本地合成字幕");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
