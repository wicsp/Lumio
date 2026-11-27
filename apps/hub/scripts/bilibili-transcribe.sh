#!/usr/bin/env bash
# Install as a dedicated, allowlisted Runtime command. Only its transcript goes to the Job log.
set -euo pipefail
umask 077
export LC_ALL=C
fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ $# == 1 && "$1" =~ ^https://www\.bilibili\.com/video/(BV[A-Za-z0-9]{10}|av[0-9]{1,20})(\?p=[1-9][0-9]{0,5})?$ ]] ||
  fail "Expected one canonical Bilibili video URL."
for tool in yt-dlp ffmpeg whisper-cli; do
  command -v "$tool" >/dev/null || fail "Missing Runtime tool: $tool."
done
model=${WHISPER_CPP_MODEL:-"$HOME/.local/share/whisper/ggml-large-v3-turbo.bin"}
[[ -r "$model" && -f "$model" ]] || fail "The Runtime Whisper model is missing."
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
ffmpeg -v error -nostdin -protocol_whitelist file,pipe -i "${audio[0]}" -map 0:a:0 -ar 16000 -ac 1 \
  -c:a pcm_s16le "$work/audio.wav" >/dev/null 2>&1 ||
  fail "Could not decode the Bilibili audio track."
whisper-cli -m "$model" -f "$work/audio.wav" -l auto -ovtt -of "$work/transcript" -np >/dev/null 2>&1 ||
  fail "Whisper could not transcribe the audio track."
[[ -s "$work/transcript.vtt" ]] || fail "Whisper returned no transcript."

printf 'LUMIO-BILIBILI-TRANSCRIPT 1\n'
cat "$work/title.json" "$work/transcript.vtt"
