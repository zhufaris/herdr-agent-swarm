#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
STATE_DIR="${1:?usage: stage-production-runtime.sh <state-directory>}"
BUILD_INFO="$ROOT/dist/build-info.json"
test -r "$BUILD_INFO"
readarray -t IDENTITY < <(node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!/^sha256:[a-f0-9]{64}$/.test(value.buildId) || !/^[a-f0-9]{40}$/.test(value.gitCommit)) process.exit(1); console.log(value.buildId.slice(7)); console.log(value.gitCommit.slice(0,12));' "$BUILD_INFO")
BUILD_ID="${IDENTITY[0]}"
GIT_COMMIT="${IDENTITY[1]}"
RELEASE_KEY="$BUILD_ID-$GIT_COMMIT"
RELEASES="$STATE_DIR/releases"
RELEASE="$RELEASES/$RELEASE_KEY"
KEEP_INACTIVE="${SWARM_RELEASE_RETENTION:-3}"
[[ "$KEEP_INACTIVE" =~ ^[0-9]+$ ]] || { echo "SWARM_RELEASE_RETENTION must be a non-negative integer" >&2; exit 2; }
install -d -m 700 "$STATE_DIR" "$RELEASES"
PREVIOUS=""
if [ -L "$STATE_DIR/current" ]; then PREVIOUS="$(readlink -f -- "$STATE_DIR/current")"; fi
STAGING="$(mktemp -d "$RELEASES/.staging.XXXXXX")"
LINK="$STATE_DIR/.current.$$"
trap 'rm -rf -- "$STAGING"; rm -f -- "$LINK"' EXIT
cp -R "$ROOT/dist" "$STAGING/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGING/"
npm --prefix "$STAGING" ci --omit=dev
if [ ! -d "$RELEASE" ]; then mv "$STAGING" "$RELEASE"; else rm -rf -- "$STAGING"; fi
ln -s "$RELEASE" "$LINK"
mv -Tf "$LINK" "$STATE_DIR/current"
kept_inactive=0
while IFS= read -r -d '' entry; do
  candidate="${entry#* }"
  [ "$(dirname -- "$candidate")" = "$RELEASES" ] || continue
  [[ "$(basename -- "$candidate")" =~ ^[a-f0-9]{64}-[a-f0-9]{12}$ ]] || continue
  if [ "$candidate" = "$RELEASE" ] || { [ -n "$PREVIOUS" ] && [ "$candidate" = "$PREVIOUS" ]; }; then continue; fi
  if [ "$kept_inactive" -lt "$KEEP_INACTIVE" ]; then
    kept_inactive=$((kept_inactive + 1))
    continue
  fi
  rm -rf -- "$candidate"
done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.staging.*' -printf '%T@ %p\0' | sort -zrn)
trap - EXIT
printf '%s\n' "$RELEASE"
