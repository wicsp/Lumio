#!/usr/bin/env bash
set -euo pipefail
umask 077

stage=$1 version=$2 digest=$3
config=/etc/lumio-mio-trial
hub=lumio-mio-trial.service
runtime=lumio-mio-runtime.service
proxy=lumio-mio-https.service
db=/var/lib/lumio-mio-trial/db
runtime_state=/var/lib/lumio-mio-runtime
base=http://127.0.0.1:17420
public_url=$(systemctl cat "$hub" | sed -n 's/^Environment=LUMIO_PUBLIC_URL=//p')
test -n "$public_url"

exec 9>/var/lib/lumio-mio-trial-staging/deployment.lock
flock -n 9 || { echo "Mio already has a deployment in progress." >&2; exit 1; }
read -r loader flag libs _ < <(systemctl cat "$hub" | sed -n 's/^ExecStart=//p')
test "$flag" = --library-path

old=$(readlink -f "$config/current-lumio")
old_version=$("$loader" --library-path "$libs" "$old" --version)
printf '%s  %s/deploy.tar.gz\n' "$digest" "$stage" | sha256sum -c
tar -xzf "$stage/deploy.tar.gz" -C "$stage"
test "$("$loader" --library-path "$libs" "$stage/lumio" --version)" = "$version"
binary=$(nix-store --add-fixed sha256 "$stage/lumio")

check_idle() {
  BUN_BE_BUN=1 "$loader" --library-path "$libs" "$binary" -e '
    import { Database } from "bun:sqlite";
    using hub = new Database(process.argv[1], { readonly: true });
    using runtime = new Database(process.argv[2], { readonly: true });
    hub.exec("PRAGMA busy_timeout=5000");
    runtime.exec("PRAGMA busy_timeout=5000");
    const busy = hub.query("SELECT 1 FROM assistant_turns WHERE status = '\''running'\'' LIMIT 1").get()
      || runtime.query("SELECT 1 FROM queue WHERE state = '\''running'\'' LIMIT 1").get();
    if (busy) throw new Error("Wait for the Hub assistant and Mio Runtime to finish active work.");
  ' "$db/hub.sqlite" "$runtime_state/runtime.sqlite"
}

verify_web() {
  local endpoint=$1 expected=$2
  curl -fsS --max-time 4 "$endpoint/health" |
    jq -e --arg version "$expected" '.ok == true and .version == $version' >/dev/null || return
  for path in / /assets/app.js /assets/app.css; do
    # A Runtime downloading its update can share the public link with this check.
    curl -fsS --compressed --connect-timeout 5 --max-time 60 --speed-limit 1024 --speed-time 15 \
      "$endpoint$path" -o /dev/null || return
  done
}

verify_runtime() {
  BUN_BE_BUN=1 "$loader" --library-path "$libs" "$binary" -e '
    import { Database } from "bun:sqlite";
    using hub = new Database(process.argv[1], { readonly: true });
    hub.exec("PRAGMA busy_timeout=5000");
    const row = hub.query("SELECT 1 FROM runtimes WHERE name = '\''mio'\'' AND last_seen >= ? AND json_extract(registration, '\''$.version'\'') = ?").get(process.argv[2], process.argv[3]);
    process.exitCode = row ? 0 : 1;
  ' "$db/hub.sqlite" "$1" "$2"
}

restart_and_verify() {
  local expected=$1 started
  started=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  systemctl restart "$hub" "$runtime" "$proxy" || return
  for attempt in {1..30}; do
    if verify_web "$base" "$expected" && verify_web "$public_url" "$expected" && verify_runtime "$started" "$expected"; then
      return
    fi
    sleep 1
  done
  return 1
}

switch_link() {
  local target=$1 link=$2
  ln -sfn "$target" "$link.new"
  mv -Tf "$link.new" "$link"
}

if [ "$old_version" = "$version" ]; then
  verify_web "$public_url" "$version"
  echo "Mio is already serving $version."
  exit
fi

check_idle
LUMIO_STATE_DIR="$db" "$loader" --library-path "$libs" "$old" hub backup business "$stage/business" >/dev/null
"$loader" --library-path "$libs" "$old" hub backup verify "$stage/business" >/dev/null
check_idle

updates=$db/updates
mkdir -p "$updates"
chown --reference="$db" "$updates"
if [ -e "$updates/versions.json" ]; then
  cp -p "$updates/versions.json" "$stage/previous-updates.json"
fi
if [ ! -d "$updates/$version" ]; then
  incoming=$(mktemp -d "$updates/.mio-deploy.XXXXXXXX")
  cp -a "$stage/updates/$version/." "$incoming"
  chown -R --reference="$db" "$incoming"
  mv -T "$incoming" "$updates/$version"
fi
jq -n --arg current "$version" --arg previous "$old_version" '{current:$current,previous:$previous}' > "$updates/.versions.new"
chown --reference="$db" "$updates/.versions.new"
mv -Tf "$updates/.versions.new" "$updates/versions.json"

switch_link "$old" /nix/var/nix/gcroots/lumio-mio-previous
switch_link "$binary" /nix/var/nix/gcroots/lumio-mio-current
switch_link "$old" "$config/previous-lumio"
switch_link "$binary" "$config/current-lumio"
if ! restart_and_verify "$version"; then
  switch_link "$old" "$config/current-lumio"
  switch_link "$old" /nix/var/nix/gcroots/lumio-mio-current
  if [ -f "$stage/previous-updates.json" ]; then
    cp -p "$stage/previous-updates.json" "$updates/.versions.new"
    mv -Tf "$updates/.versions.new" "$updates/versions.json"
  else
    rm -f "$updates/versions.json"
  fi
  if restart_and_verify "$old_version"; then
    echo "Mio activation failed. Verified rollback to $old_version." >&2
  else
    echo "Mio activation and rollback checks failed. See $stage." >&2
  fi
  exit 1
fi
for folder in "$updates"/*; do
  name=$(basename "$folder")
  if [[ -d "$folder" && "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][a-zA-Z0-9.-]+)?$ && "$name" != "$version" && "$name" != "$old_version" ]]; then
    rm -rf -- "$folder"
  fi
done
rm -rf -- "$stage/deploy.tar.gz" "$stage/lumio" "$stage/updates"
echo "Verified $version at $public_url with a fresh Mio Runtime heartbeat."
