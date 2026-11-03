#!/bin/sh
set -eu

# POSIX shell counterpart of the locale rule; LC_ALL takes precedence over LANG.
install_language=en
case "${LC_ALL:-${LANG:-}}" in zh*) install_language=zh ;; esac
message() {
  message_key=$1
  shift
  # The PATH hint is shown for the user to copy, so $HOME stays literal there.
  # shellcheck disable=SC2016
  case "$install_language:$message_key" in
    zh:install_failed) message_format='Lumio 安装失败：%s\n' ;;
    en:install_failed) message_format='Lumio installation failed: %s\n' ;;
    zh:usage) message_format='用法：install.sh [--server] [--vault <路径>] [--public-url <地址>] [--version vX.Y.Z] [--no-setup]；install.sh runtime --hub <地址> --code <配对码> [--version vX.Y.Z]' ;;
    en:usage) message_format='Usage: install.sh [--server] [--vault <path>] [--public-url <url>] [--version vX.Y.Z] [--no-setup]; install.sh runtime --hub <url> --code <pairing-code> [--version vX.Y.Z]' ;;
    zh:version) message_format='版本应为 vX.Y.Z' ;;
    en:version) message_format='Version must be vX.Y.Z' ;;
    zh:version_format) message_format='版本格式不合法' ;;
    en:version_format) message_format='Invalid version format' ;;
    zh:os) message_format='无法识别系统' ;;
    en:os) message_format='Could not identify operating system' ;;
    zh:arch) message_format='无法识别架构' ;;
    en:arch) message_format='Could not identify architecture' ;;
    zh:platform) message_format='不支持的平台：%s/%s（支持 macOS arm64、Linux x64/arm64）' ;;
    en:platform) message_format='Unsupported platform: %s/%s (supported: macOS arm64, Linux x64/arm64)' ;;
    zh:curl) message_format='需要 curl' ;;
    en:curl) message_format='curl is required' ;;
    zh:tar) message_format='需要 tar' ;;
    en:tar) message_format='tar is required' ;;
    zh:home) message_format='需要 HOME' ;;
    en:home) message_format='HOME is required' ;;
    zh:temp) message_format='无法创建临时目录' ;;
    en:temp) message_format='Could not create temporary directory' ;;
    zh:download_size) message_format='下载 Lumio %s（%s） %s…\n' ;;
    en:download_size) message_format='Downloading Lumio %s (%s) %s…\n' ;;
    zh:download) message_format='下载 Lumio %s（%s）…\n' ;;
    en:download) message_format='Downloading Lumio %s (%s)…\n' ;;
    zh:latest) message_format='最新版本' ;;
    en:latest) message_format='latest version' ;;
    zh:slow) message_format='下载太慢或卡住，请检查网络或代理（https_proxy）后重试；也请确认版本存在' ;;
    en:slow) message_format='Download stalled or too slow; check network or proxy (https_proxy), and confirm the version exists' ;;
    zh:sums) message_format='下载 SHA256SUMS 失败，下载太慢或卡住，请检查网络或代理（https_proxy）后重试' ;;
    en:sums) message_format='Could not download SHA256SUMS; check network or proxy (https_proxy) and retry' ;;
    zh:sum_entries) message_format='SHA256SUMS 缺少或重复的校验记录' ;;
    en:sum_entries) message_format='SHA256SUMS has missing or duplicate entries' ;;
    zh:sum_format) message_format='SHA256SUMS 格式不合法' ;;
    en:sum_format) message_format='Invalid SHA256SUMS format' ;;
    zh:hash) message_format='计算 SHA256' ;;
    en:hash) message_format='Compute SHA256' ;;
    zh:checksum) message_format='SHA256 校验失败，未安装任何程序' ;;
    en:checksum) message_format='SHA256 verification failed; no programs were installed' ;;
    zh:read_archive) message_format='读取压缩包' ;;
    en:read_archive) message_format='Read archive' ;;
    zh:archive) message_format='压缩包内容不合法' ;;
    en:archive) message_format='Invalid archive contents' ;;
    zh:paths) message_format='压缩包缺少程序或含非预期路径' ;;
    en:paths) message_format='Archive has missing programs or unexpected paths' ;;
    zh:read_types) message_format='读取压缩包类型' ;;
    en:read_types) message_format='Read archive types' ;;
    zh:types) message_format='压缩包类型记录不合法' ;;
    en:types) message_format='Invalid archive type records' ;;
    zh:regular) message_format='压缩包含非普通程序文件' ;;
    en:regular) message_format='Archive contains non-regular program files' ;;
    zh:extract) message_format='解压程序' ;;
    en:extract) message_format='Extract program' ;;
    zh:shim) message_format='发布包转发垫片内容不匹配，未安装任何程序' ;;
    en:shim) message_format='Release forwarding shim content mismatch; no programs were installed' ;;
    zh:mkdir) message_format='创建 ~/.local/bin' ;;
    en:mkdir) message_format='Create ~/.local/bin' ;;
    zh:copy) message_format='复制程序' ;;
    en:copy) message_format='Copy program' ;;
    zh:mode) message_format='设置程序权限' ;;
    en:mode) message_format='Set program permissions' ;;
    zh:replace) message_format='替换程序' ;;
    en:replace) message_format='Replace program' ;;
    zh:link) message_format='创建兼容链接' ;;
    en:link) message_format='Create compatibility link' ;;
    zh:replace_link) message_format='替换兼容链接' ;;
    en:replace_link) message_format='Replace compatibility link' ;;
    zh:installed) message_format='已安装到 %s\n' ;;
    en:installed) message_format='Installed to %s\n' ;;
    zh:path) message_format='请将 ~/.local/bin 加入 PATH：export PATH="$HOME/.local/bin:$PATH"\n' ;;
    en:path) message_format='Add ~/.local/bin to PATH: export PATH="$HOME/.local/bin:$PATH"\n' ;;
    *) return 1 ;;
  esac
  # Formats come only from the fixed table above; arguments go through %s.
  # shellcheck disable=SC2059
  printf "$message_format" "$@"
}


fail() { message install_failed "$1" >&2; exit 1; }
usage() { fail "$(message usage)"; }
mode=hub
server=no
setup=yes
version=
hub=
code=
vault=
public_url=
if [ "${1-}" = runtime ]; then mode=runtime; shift; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) [ "$mode" = hub ] || usage; server=yes; shift ;;
    --vault) [ "$mode" = hub ] || usage; [ "$#" -ge 2 ] || usage; [ -n "$2" ] || usage; vault=$2; shift 2 ;;
    --public-url) [ "$mode" = hub ] || usage; [ "$#" -ge 2 ] || usage; [ -n "$2" ] || usage; public_url=$2; shift 2 ;;
    --no-setup) setup=no; shift ;;
    --version) [ "$#" -ge 2 ] || usage; version=$2; shift 2 ;;
    --hub) [ "$mode" = runtime ] || usage; [ "$#" -ge 2 ] || usage; hub=$2; shift 2 ;;
    --code) [ "$mode" = runtime ] || usage; [ "$#" -ge 2 ] || usage; code=$2; shift 2 ;;
    *) usage ;;
  esac
done
if [ "$mode" = runtime ] && { [ -z "$hub" ] || [ -z "$code" ]; }; then usage; fi
if [ -n "$version" ]; then
  case "$version" in v[0-9]*.[0-9]*.[0-9]*) ;; *) fail "$(message version)" ;; esac
  case "$version" in *[!a-zA-Z0-9.v-]*) fail "$(message version_format)" ;; esac
fi
os=$(uname -s) || fail "$(message os)"
arch=$(uname -m) || fail "$(message arch)"
case "$os/$arch" in
  Darwin/arm64) platform=darwin-arm64 ;;
  Linux/x86_64|Linux/amd64) platform=linux-x64 ;;
  Linux/aarch64|Linux/arm64) platform=linux-arm64 ;;
  *) fail "$(message platform "$os" "$arch")" ;;
esac
command -v curl >/dev/null 2>&1 || fail "$(message curl)"
command -v tar >/dev/null 2>&1 || fail "$(message tar)"
: "${HOME:?$(message home)}"
# Override only for mirrors and the synthetic release tests.
base=${LUMIO_RELEASE_BASE_URL:-https://github.com/wicsp/Lumio/releases}
if [ -n "$version" ]; then base=$base/download/$version; else base=$base/latest/download; fi
archive=lumio-$platform.tar.gz
umask 077
tmp=$(mktemp -d) || fail "$(message temp)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
# HEAD is optional: mirrors may omit Content-Length or reject HEAD entirely.
size=$(curl -fsSLI --connect-timeout 20 --max-time 20 "$base/$archive" 2>/dev/null | awk '
  /^HTTP\// { size="" }
  tolower($1) == "content-length:" { gsub("\r", "", $2); size=$2 }
  END { if (size ~ /^[0-9]+$/ && size > 0) {
    split("B KB MB GB", units, " "); unit=1;
    while (size >= 1024 && unit < 4) { size/=1024; unit++ }
    printf "%.1f %s", size, units[unit]
  } }') || size=
if [ -n "$size" ]; then
  message download_size "${version:-$(message latest)}" "$platform" "$size"
else
  message download "${version:-$(message latest)}" "$platform"
fi
# Progress belongs on stderr; redirected installation logs stay quiet.
if [ -t 2 ]; then set -- -fL --progress-bar; else set -- -fsSL; fi
curl "$@" --connect-timeout 20 --speed-limit 1024 --speed-time 60 "$base/$archive" -o "$tmp/$archive" || fail "$(message slow)"
curl -fsSL --connect-timeout 20 --speed-limit 1024 --speed-time 60 "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "$(message sums)"
expected=$(awk -v file="$archive" '$2 == file { print $1; count++ } END { if (count != 1) exit 1 }' "$tmp/SHA256SUMS") || fail "$(message sum_entries)"
[ "${#expected}" -eq 64 ] || fail "$(message sum_format)"
case "$expected" in *[!0-9a-fA-F]*) fail "$(message sum_format)" ;; esac
if [ "$os" = Darwin ]; then
  actual=$(shasum -a 256 "$tmp/$archive") || fail "$(message hash)"
else
  actual=$(sha256sum "$tmp/$archive") || fail "$(message hash)"
fi
actual=${actual%% *}
[ "$actual" = "$expected" ] || fail "$(message checksum)"
tar -tzf "$tmp/$archive" > "$tmp/contents" || fail "$(message read_archive)"
[ "$(wc -l < "$tmp/contents" | tr -d ' ')" = 3 ] || fail "$(message archive)"
for binary in lumio lumio-hub lumio-runtime; do
  [ "$(awk -v file="$binary" '$0 == file { n++ } END { print n+0 }' "$tmp/contents")" = 1 ] || fail "$(message paths)"
done
tar -tvzf "$tmp/$archive" > "$tmp/types" || fail "$(message read_types)"
[ "$(wc -l < "$tmp/types" | tr -d ' ')" = 3 ] || fail "$(message types)"
[ "$(cut -c1 "$tmp/types" | tr -d '\n')" = --- ] || fail "$(message regular)"
mkdir "$tmp/extracted"
tar -xzf "$tmp/$archive" -C "$tmp/extracted" || fail "$(message extract)"
for binary in lumio lumio-hub lumio-runtime; do
  if [ ! -f "$tmp/extracted/$binary" ] || [ -L "$tmp/extracted/$binary" ]; then fail "$(message regular)"; fi
done
for role in hub runtime; do
  # shellcheck disable=SC2016 # Compare literal shim bytes; do not expand its shell variables here.
  printf '#!/bin/sh\nexec "$(dirname "$0")/lumio" %s "$@"\n' "$role" > "$tmp/expected-$role"
  cmp -s "$tmp/expected-$role" "$tmp/extracted/lumio-$role" || fail "$(message shim)"
done
bin=$HOME/.local/bin
mkdir -p "$bin" || fail "$(message mkdir)"
cp "$tmp/extracted/lumio" "$bin/.lumio.new.$$" || fail "$(message copy)"
chmod 755 "$bin/.lumio.new.$$" || fail "$(message mode)"
mv -f "$bin/.lumio.new.$$" "$bin/lumio" || fail "$(message replace)"
for alias in lumio-hub lumio-runtime; do
  ln -s lumio "$bin/.$alias.new.$$" || fail "$(message link)"
  mv -f "$bin/.$alias.new.$$" "$bin/$alias" || fail "$(message replace_link)"
done
message installed "$bin"
case ":${PATH-}:" in
  *":$bin:"*) ;;
  *)
    # shellcheck disable=SC2016 # Print the command for the user's shell.
    message path ;;
esac
[ "$setup" = yes ] || exit 0
if [ "$mode" = runtime ]; then
  "$bin/lumio" runtime join --hub "$hub" --code "$code" || fail 'lumio-runtime join'
else
  set -- "$bin/lumio" hub setup
  if [ "$server" = yes ]; then set -- "$@" --server; fi
  if [ -n "$vault" ]; then set -- "$@" --vault "$vault"; fi
  if [ -n "$public_url" ]; then set -- "$@" --public-url "$public_url"; fi
  # curl | sh owns stdin; reconnect setup to the controlling terminal if one exists.
  if [ ! -t 0 ] && ( : < /dev/tty ) 2>/dev/null; then
    "$@" < /dev/tty || fail 'lumio-hub setup'
  else
    "$@" || fail 'lumio-hub setup'
  fi
fi
