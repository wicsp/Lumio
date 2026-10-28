#!/bin/sh
set -eu

fail() { printf 'Lumio 安装失败：%s\n' "$1" >&2; exit 1; }
usage() { fail '用法：install.sh [--server] [--vault <路径>] [--version vX.Y.Z] [--no-setup]；install.sh runtime --hub <地址> --code <配对码> [--version vX.Y.Z]'; }
mode=hub
server=no
setup=yes
version=
hub=
code=
vault=
if [ "${1-}" = runtime ]; then mode=runtime; shift; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) [ "$mode" = hub ] || usage; server=yes; shift ;;
    --vault) [ "$mode" = hub ] || usage; [ "$#" -ge 2 ] || usage; [ -n "$2" ] || usage; vault=$2; shift 2 ;;
    --no-setup) setup=no; shift ;;
    --version) [ "$#" -ge 2 ] || usage; version=$2; shift 2 ;;
    --hub) [ "$mode" = runtime ] || usage; [ "$#" -ge 2 ] || usage; hub=$2; shift 2 ;;
    --code) [ "$mode" = runtime ] || usage; [ "$#" -ge 2 ] || usage; code=$2; shift 2 ;;
    *) usage ;;
  esac
done
if [ "$mode" = runtime ] && { [ -z "$hub" ] || [ -z "$code" ]; }; then usage; fi
if [ -n "$version" ]; then
  case "$version" in v[0-9]*.[0-9]*.[0-9]*) ;; *) fail '版本应为 vX.Y.Z' ;; esac
  case "$version" in *[!a-zA-Z0-9.v-]*) fail '版本格式不合法' ;; esac
fi
os=$(uname -s) || fail '无法识别系统'
arch=$(uname -m) || fail '无法识别架构'
case "$os/$arch" in
  Darwin/arm64) platform=darwin-arm64 ;;
  Linux/x86_64|Linux/amd64) platform=linux-x64 ;;
  Linux/aarch64|Linux/arm64) platform=linux-arm64 ;;
  *) fail "不支持的平台：${os}/${arch}（支持 macOS arm64、Linux x64/arm64）" ;;
esac
command -v curl >/dev/null 2>&1 || fail '需要 curl'
command -v tar >/dev/null 2>&1 || fail '需要 tar'
: "${HOME:?需要 HOME}"
# Override only for mirrors and the synthetic release tests.
base=${LUMIO_RELEASE_BASE_URL:-https://github.com/wicsp/Lumio/releases}
if [ -n "$version" ]; then base=$base/download/$version; else base=$base/latest/download; fi
archive=lumio-$platform.tar.gz
umask 077
tmp=$(mktemp -d) || fail '无法创建临时目录'
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
printf '下载 Lumio（%s）…\n' "$platform"
curl -fsSL "$base/$archive" -o "$tmp/$archive" || fail '下载程序压缩包，请检查网络与版本'
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail '下载 SHA256SUMS'
expected=$(awk -v file="$archive" '$2 == file { print $1; count++ } END { if (count != 1) exit 1 }' "$tmp/SHA256SUMS") || fail 'SHA256SUMS 缺少或重复的校验记录'
[ "${#expected}" -eq 64 ] || fail 'SHA256SUMS 格式不合法'
case "$expected" in *[!0-9a-fA-F]*) fail 'SHA256SUMS 格式不合法' ;; esac
if [ "$os" = Darwin ]; then
  actual=$(shasum -a 256 "$tmp/$archive") || fail '计算 SHA256'
else
  actual=$(sha256sum "$tmp/$archive") || fail '计算 SHA256'
fi
actual=${actual%% *}
[ "$actual" = "$expected" ] || fail 'SHA256 校验失败，未安装任何程序'
tar -tzf "$tmp/$archive" > "$tmp/contents" || fail '读取压缩包'
[ "$(wc -l < "$tmp/contents" | tr -d ' ')" = 3 ] || fail '压缩包内容不合法'
for binary in lumio lumio-hub lumio-runtime; do
  [ "$(awk -v file="$binary" '$0 == file { n++ } END { print n+0 }' "$tmp/contents")" = 1 ] || fail '压缩包缺少程序或含非预期路径'
done
mkdir "$tmp/extracted"
tar -xzf "$tmp/$archive" -C "$tmp/extracted" || fail '解压程序'
for binary in lumio lumio-hub lumio-runtime; do
  if [ ! -f "$tmp/extracted/$binary" ] || [ -L "$tmp/extracted/$binary" ]; then fail '压缩包含非普通程序文件'; fi
done
bin=$HOME/.local/bin
mkdir -p "$bin" || fail '创建 ~/.local/bin'
for binary in lumio lumio-hub lumio-runtime; do
  cp "$tmp/extracted/$binary" "$bin/.$binary.new.$$" || fail '复制程序'
  chmod 755 "$bin/.$binary.new.$$" || fail '设置程序权限'
  mv -f "$bin/.$binary.new.$$" "$bin/$binary" || fail '替换程序'
done
printf '已安装到 %s\n' "$bin"
case ":${PATH-}:" in
  *":$bin:"*) ;;
  *)
    # shellcheck disable=SC2016 # Print the command for the user's shell.
    printf '请将 ~/.local/bin 加入 PATH：export PATH="$HOME/.local/bin:$PATH"\n' ;; 
esac
[ "$setup" = yes ] || exit 0
if [ "$mode" = runtime ]; then
  "$bin/lumio-runtime" join --hub "$hub" --code "$code" || fail 'lumio-runtime join'
else
  set -- "$bin/lumio-hub" setup
  if [ "$server" = yes ]; then set -- "$@" --server; fi
  if [ -n "$vault" ]; then set -- "$@" --vault "$vault"; fi
  # curl | sh owns stdin; reconnect setup to the controlling terminal if one exists.
  if [ ! -t 0 ] && ( : < /dev/tty ) 2>/dev/null; then
    "$@" < /dev/tty || fail 'lumio-hub setup'
  else
    "$@" || fail 'lumio-hub setup'
  fi
fi
