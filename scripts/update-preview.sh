#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

cd "$(git rev-parse --show-toplevel)"
[[ $(git branch --show-current) == preview ]] || fail '请在专用 preview 工作树中运行。'
[[ -z $(git status --porcelain) ]] || fail 'preview 工作树须干净。'
[[ $(uname -s) == Darwin ]] || fail '试用更新命令需要 macOS launchd。'

trial="$HOME/.local/share/lumio-native-trial"
[[ -d "$trial/bin" && $(cd "$trial/bin" && pwd -P) == "$trial/bin" ]] ||
  fail '缺少独立试用安装，或试用程序目录通过符号链接指向其他位置。'
for dir in hub runtime home; do
  [[ -d "$trial/$dir" && ! -L "$trial/$dir" ]] || fail "试用状态目录无效：$trial/$dir"
done
binary="$trial/bin/lumio"
[[ -f "$binary" && ! -L "$binary" ]] || fail '缺少独立试用程序。'
domain="gui/$(id -u)"
label="io.lumio.native-trial"
agent_dir="$HOME/Library/LaunchAgents"
url="http://127.0.0.1:7421"

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null
}

for role in hub runtime; do
  plist="$agent_dir/$label.$role.plist"
  [[ $(plist_value "$plist" Label) == "$label.$role" &&
    $(plist_value "$plist" ProgramArguments:0) == "$binary" &&
    $(plist_value "$plist" ProgramArguments:1) == "$role" &&
    $(plist_value "$plist" ProgramArguments:2) == serve &&
    $(plist_value "$plist" EnvironmentVariables:HOME) == "$trial/home" ]] ||
    fail "试用服务配置不匹配，检查 $plist。"
done
hub_plist="$agent_dir/$label.hub.plist"
runtime_plist="$agent_dir/$label.runtime.plist"
[[ $(plist_value "$hub_plist" EnvironmentVariables:LUMIO_STATE_DIR) == "$trial/hub" &&
  $(plist_value "$hub_plist" EnvironmentVariables:LUMIO_HUB_LISTEN) == 127.0.0.1:7421 &&
  -z $(plist_value "$hub_plist" EnvironmentVariables:LUMIO_VAULT || true) &&
  $(plist_value "$runtime_plist" EnvironmentVariables:LUMIO_RUNTIME_STATE_DIR) == "$trial/runtime" &&
  $(plist_value "$runtime_plist" EnvironmentVariables:LUMIO_HUB_URL) == "$url" ]] ||
  fail '试用服务必须使用独立状态和 7421，并且不挂载 vault。'

lock="$trial/.update-lock"
mkdir "$lock" || fail "已有试用更新在运行。若上次被强制终止，确认没有更新进程后移除 $lock。"
trap 'rm -rf -- "$lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

updater=$(git rev-parse HEAD:scripts/update-preview.sh)
git pull --ff-only origin preview
commit=$(git rev-parse HEAD)
[[ "$commit" == "$(git rev-parse FETCH_HEAD)" ]] || fail '本地 preview 含有尚未推送的提交。'

# A pull can replace this script while Bash is still reading the old copy.
updated_updater=$(git rev-parse HEAD:scripts/update-preview.sh)
if [[ "$updater" != "$updated_updater" ]]; then
  trap - EXIT INT TERM
  rmdir "$lock"
  exec bash "$PWD/scripts/update-preview.sh"
fi

required=$(bun -e 'console.log(require("./package.json").packageManager.replace(/^bun@/, ""))')
[[ $(bun --version) == "$required" ]] || fail "此提交需要 Bun $required。"
bun install --frozen-lockfile
version="0.0.0-preview.$commit"
bun run apps/cli/src/build-binary.ts --outfile "$lock/lumio" --version "$version"

# Keep the old executable and replace the live path in one rename on the same filesystem.
previous="$binary.previous"
if [[ -e "$trial/preview-commit" || ! -f "$previous" ]]; then
  [[ ! -e "$previous" || ( -f "$previous" && ! -L "$previous" ) ]] || fail '旧程序备份路径无效。'
  cp -p "$binary" "$lock/previous"
  mv -f "$lock/previous" "$previous"
fi
mv -f "$lock/lumio" "$binary"
rm -f "$trial/preview-commit"

restart() {
  local role=$1 target="$domain/$label.$1"
  if launchctl print "$target" >/dev/null 2>&1; then
    launchctl kickstart -k "$target"
  else
    launchctl bootstrap "$domain" "$agent_dir/$label.$role.plist"
  fi
}

restart hub || fail '试用 Hub 重启失败，旧程序保存在 bin/lumio.previous。'
for ((attempt = 0; attempt < 20; attempt++)); do
  if curl --noproxy '*' -fsS --max-time 1 "$url/health" 2>/dev/null |
    grep -Fq "\"version\":\"$version\""; then
    restart runtime || fail '试用 Runtime 重启失败，旧程序保存在 bin/lumio.previous。'
    printf '%s\n' "$commit" > "$lock/commit"
    mv -f "$lock/commit" "$trial/preview-commit"
    printf '试用版本 %s\n%s\n' "$commit" "$url"
    exit 0
  fi
  sleep 1
done
fail '试用 Hub 未报告预期版本。检查试用日志，旧程序保存在 bin/lumio.previous。'
