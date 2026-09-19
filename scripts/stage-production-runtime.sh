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
validate_release() {
    [ -d "$RELEASE" ] && [ ! -L "$RELEASE" ] && [ -r "$RELEASE/dist/build-info.json" ] && [ -r "$RELEASE/package.json" ] && [ -r "$RELEASE/package-lock.json" ] && [ -d "$RELEASE/node_modules" ]
    node -e 'const fs=require("node:fs"); const expected=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const actual=JSON.parse(fs.readFileSync(process.argv[2], "utf8")); if (actual.buildId !== expected.buildId || actual.gitCommit !== expected.gitCommit) process.exit(1);' "$BUILD_INFO" "$RELEASE/dist/build-info.json"
}
if [ -e "$RELEASE" ]; then
    if validate_release; then printf '%s\n' "$RELEASE"; exit 0; fi
    echo "Existing immutable release failed validation: $RELEASE" >&2
    exit 1
fi
STAGING="$(mktemp -d "$RELEASES/.staging.XXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT
cp -R "$ROOT/dist" "$STAGING/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGING/"
npm --prefix "$STAGING" ci --omit=dev >&2
if [ ! -d "$RELEASE" ]; then mv "$STAGING" "$RELEASE"; elif validate_release; then rm -rf -- "$STAGING"; else echo "Concurrent immutable release failed validation: $RELEASE" >&2; exit 1; fi
trap - EXIT
printf '%s\n' "$RELEASE"
