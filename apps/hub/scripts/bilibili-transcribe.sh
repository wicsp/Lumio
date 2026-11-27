#!/usr/bin/env bash
# Install as a dedicated, allowlisted Runtime command. Only its transcript goes to the Job log.
set -euo pipefail
umask 077
export LC_ALL=C
fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ $# == 1 && "$1" =~ ^https://www\.bilibili\.com/video/(BV[A-Za-z0-9]{10}|av[0-9]{1,20})(\?p=[1-9][0-9]{0,5})?$ ]] ||
  fail "Expected one canonical Bilibili video URL."
key_file=${BILIBILI_GROQ_API_KEY_FILE:-"$HOME/.config/lumio/credentials/bilibili-groq"}
tools=(yt-dlp ffmpeg)
groq_key=
if [[ -n "${BILIBILI_GROQ_API_KEY_FILE:-}" || -e "$key_file" ]]; then
  [[ -f "$key_file" && -r "$key_file" ]] || fail "The Runtime Groq credential could not be read."
  groq_key=$(<"$key_file")
  [[ "$groq_key" =~ ^gsk_[a-zA-Z0-9_-]+$ ]] || fail "The Runtime Groq credential is invalid."
  tools+=(curl ffprobe python3)
else
  tools+=(whisper-cli)
  model=${WHISPER_CPP_MODEL:-"$HOME/.local/share/whisper/ggml-large-v3-turbo.bin"}
  [[ -r "$model" && -f "$model" ]] || fail "The Runtime Whisper model is missing."
fi
for tool in "${tools[@]}"; do
  command -v "$tool" >/dev/null || fail "Missing Runtime tool: $tool."
done
# Bound files even if a media server omits or misreports the Content-Length.
ulimit -f 524288
work=$(mktemp -d "${TMPDIR:-/tmp}/lumio-bilibili.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 1' HUP INT TERM

download_flags=(--ignore-config --no-plugin-dirs --use-extractors BiliBili --no-playlist --playlist-items 1 --no-progress)
if [[ -n "${BILIBILI_COOKIES_FILE:-}" ]]; then
  # yt-dlp can write back to its cookie file. Use a private per-job copy.
  cp -- "$BILIBILI_COOKIES_FILE" "$work/cookies.txt" || fail "The Runtime Bilibili cookie file could not be read."
  download_flags+=(--cookies "$work/cookies.txt")
fi
yt-dlp "${download_flags[@]}" \
  --no-simulate --socket-timeout 20 --retries 2 --max-filesize 128M --match-filters 'duration <= 7200' \
  -f 'bestaudio[protocol=https]' --output "$work/audio.%(ext)s" --print 'after_move:%(title)j' \
  -- "$1" >"$work/title.json" 2>/dev/null ||
  fail "Bilibili audio download failed. Check availability and the Runtime network or sign-in."
audio=("$work"/audio.*)
[[ ${#audio[@]} == 1 && -s "${audio[0]}" && -s "$work/title.json" ]] ||
  fail "No audio track was downloaded. Check the video and the duration or size limits."

if [[ -n "$groq_key" ]]; then
  upload=${audio[0]}
  upload_limit=25000000
  if (( $(wc -c <"$upload") > upload_limit )); then
    # At 24 kb/s a two-hour mono track fits the Groq free tier's 25 MB upload limit.
    upload="$work/groq.m4a"
    ffmpeg -v error -nostdin -protocol_whitelist file,pipe -i "${audio[0]}" -map 0:a:0 -ar 16000 -ac 1 \
      -c:a aac -b:a 24k "$upload" >/dev/null 2>&1 || fail "Could not compress the Bilibili audio track for Groq."
    (( $(wc -c <"$upload") <= upload_limit )) || fail "The audio track exceeds the Groq upload limit."
  fi
  duration=$(ffprobe -v error -protocol_whitelist file,pipe -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "$upload" 2>/dev/null) || fail "Could not read the Bilibili audio duration."
  [[ "$duration" =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "The Bilibili audio duration is missing."
  # Keep the credential out of process arguments, and never log a provider response body.
  status=$(printf 'Authorization: Bearer %s\n' "$groq_key" | curl --disable --silent --proto '=https' \
    --connect-timeout 15 --max-time 180 --header @- --output "$work/groq.json" --write-out '%{http_code}' \
    --form "file=@$upload" --form 'model=whisper-large-v3-turbo' --form 'response_format=verbose_json' \
    --form 'timestamp_granularities[]=segment' 'https://api.groq.com/openai/v1/audio/transcriptions') ||
    fail "Could not reach Groq for Bilibili transcription."
  unset groq_key
  [[ "$status" == 200 ]] || fail "Groq transcription failed (HTTP $status)."

  python3 - "$work/groq.json" "$duration" >"$work/transcript.vtt" 2>/dev/null <<'PY' || fail "Groq returned no usable transcript."
import json
import math
import sys


def timestamp(seconds):
    whole, millis = divmod(round(seconds * 1000), 1000)
    minutes, seconds = divmod(whole, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02}.{millis:03}"


with open(sys.argv[1], encoding="utf-8") as response:
    segments = json.load(response)["segments"]
duration = float(sys.argv[2])
cues = []
for segment in segments:
    start, end, text = segment["start"], segment["end"], segment["text"]
    if not math.isfinite(start) or not math.isfinite(end):
        continue
    start, end = max(0, start), min(duration, end)
    text = " ".join(text.split())
    if text and round(start * 1000) < round(end * 1000):
        cues.append(f"{timestamp(start)} --> {timestamp(end)}\n{text}")
if not cues:
    sys.exit(1)
print("WEBVTT", *cues, sep="\n\n")
PY
else
  ffmpeg -v error -nostdin -protocol_whitelist file,pipe -i "${audio[0]}" -map 0:a:0 -ar 16000 -ac 1 \
    -c:a pcm_s16le "$work/audio.wav" >/dev/null 2>&1 || fail "Could not decode the Bilibili audio track."
  whisper-cli -m "$model" -f "$work/audio.wav" -l auto -ovtt -of "$work/transcript" -np >/dev/null 2>&1 ||
    fail "Whisper could not transcribe the audio track."
  [[ -s "$work/transcript.vtt" ]] || fail "Whisper returned no transcript."
fi

printf 'LUMIO-BILIBILI-TRANSCRIPT 1\n'
cat "$work/title.json" "$work/transcript.vtt"
