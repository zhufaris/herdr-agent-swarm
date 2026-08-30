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
install -d -m 700 "$STATE_DIR" "$RELEASES"
STAGING="$(mktemp -d "$RELEASES/.staging.XXXXXX")"
LINK="$STATE_DIR/.current.$$"
trap 'rm -rf -- "$STAGING"; rm -f -- "$LINK"' EXIT
cp -R "$ROOT/dist" "$STAGING/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGING/"
npm --prefix "$STAGING" ci --omit=dev
if [ ! -d "$RELEASE" ]; then mv "$STAGING" "$RELEASE"; else rm -rf -- "$STAGING"; fi
ln -s "$RELEASE" "$LINK"
mv -Tf "$LINK" "$STATE_DIR/current"
trap - EXIT
printf '%s\n' "$RELEASE"
