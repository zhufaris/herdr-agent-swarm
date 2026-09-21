#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
STATE_DIR="${1:?usage: stage-production-runtime.sh <state-directory>}"
BUILD_INFO="$ROOT/dist/build-info.json"
for command_name in flock node npm sha256sum tar; do
    command -v "$command_name" >/dev/null 2>&1 || { echo "Missing required command: $command_name" >&2; exit 1; }
done
test -r "$BUILD_INFO"
readarray -t IDENTITY < <(node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!/^sha256:[a-f0-9]{64}$/.test(value.buildId) || !/^[a-f0-9]{40}$/.test(value.gitCommit)) process.exit(1); console.log(value.buildId.slice(7)); console.log(value.gitCommit.slice(0,12));' "$BUILD_INFO")
BUILD_ID="${IDENTITY[0]}"
GIT_COMMIT="${IDENTITY[1]}"
RELEASE_KEY="$BUILD_ID-$GIT_COMMIT"
RELEASES="$STATE_DIR/releases"
RELEASE="$RELEASES/$RELEASE_KEY"
LOCKS="$STATE_DIR/locks"
CACHE_ROOT="$STATE_DIR/cache/production-dependencies"
ensure_private_directory() {
    local path="$1"
    if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
        echo "Refusing unsafe managed directory: $path" >&2
        exit 1
    fi
    install -d -m 700 "$path"
    chmod 700 "$path"
}
ensure_private_directory "$STATE_DIR"
ensure_private_directory "$RELEASES"
ensure_private_directory "$STATE_DIR/locks"
ensure_private_directory "$LOCKS/releases"
ensure_private_directory "$LOCKS/production-dependencies"
ensure_private_directory "$STATE_DIR/cache"
ensure_private_directory "$CACHE_ROOT"
CACHE_STAGING=""
STAGING=""
cleanup() {
    [ -z "$CACHE_STAGING" ] || rm -rf -- "$CACHE_STAGING"
    [ -z "$STAGING" ] || rm -rf -- "$STAGING"
}
trap cleanup EXIT
validate_release() {
    [ -d "$RELEASE" ] && [ ! -L "$RELEASE" ] && [ -r "$RELEASE/dist/build-info.json" ] && [ -r "$RELEASE/package.json" ] && [ -r "$RELEASE/package-lock.json" ] && [ -d "$RELEASE/node_modules" ]
    node -e 'const fs=require("node:fs"); const expected=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const actual=JSON.parse(fs.readFileSync(process.argv[2], "utf8")); if (actual.buildId !== expected.buildId || actual.gitCommit !== expected.gitCommit) process.exit(1);' "$BUILD_INFO" "$RELEASE/dist/build-info.json"
}
RELEASE_LOCK="$LOCKS/releases/$RELEASE_KEY"
ensure_private_directory "$RELEASE_LOCK"
exec 8<"$RELEASE_LOCK"
flock 8
if [ -e "$RELEASE" ] || [ -L "$RELEASE" ]; then
    if validate_release; then printf '%s\n' "$RELEASE"; exit 0; fi
    echo "Existing immutable release failed validation: $RELEASE" >&2
    exit 1
fi
NPM_VERSION="$(npm --version)"
CACHE_STAGING="$(mktemp -d "$CACHE_ROOT/.staging.XXXXXX")"
CACHE_WORK="$CACHE_STAGING/work"
mkdir "$CACHE_WORK"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$CACHE_WORK/"
NPM_CONFIG_SHA="$(npm --prefix "$CACHE_WORK" config list --json | node "$ROOT/scripts/npm-config-fingerprint.mjs")"
readarray -t CACHE_IDENTITY < <(node "$ROOT/scripts/production-dependency-cache-key.mjs" "$ROOT/package-lock.json" "$ROOT/package.json" "$NPM_VERSION" "$NPM_CONFIG_SHA")
[ "${#CACHE_IDENTITY[@]}" -eq 14 ] || { echo "Unable to derive production dependency cache identity" >&2; exit 1; }
CACHE_KEY="${CACHE_IDENTITY[0]}"
CACHE_ENTRY="$CACHE_ROOT/$CACHE_KEY"
CACHE_ARCHIVE="$CACHE_ENTRY/node_modules.tar.gz"
CACHE_MANIFEST="$CACHE_ENTRY/manifest"
CACHE_METADATA="$(printf '%s\n' "${CACHE_IDENTITY[@]:1}")"
validate_cache() {
    [ -d "$CACHE_ENTRY" ] && [ ! -L "$CACHE_ENTRY" ] && [ -f "$CACHE_ARCHIVE" ] && [ ! -L "$CACHE_ARCHIVE" ] && [ -f "$CACHE_MANIFEST" ] && [ ! -L "$CACHE_MANIFEST" ] || return 1
    local archive_sha expected_manifest
    archive_sha="$(sha256sum "$CACHE_ARCHIVE")" || return 1
    archive_sha="${archive_sha%% *}"
    expected_manifest="${CACHE_METADATA}
archiveSha256=${archive_sha}"
    [ "$(cat "$CACHE_MANIFEST")" = "$expected_manifest" ] || return 1
    tar -tzf "$CACHE_ARCHIVE" 2>/dev/null | node -e 'const fs=require("node:fs"); const paths=fs.readFileSync(0,"utf8").trim().split(/\n/); if(!paths.length || paths.some((path)=>path!=="node_modules/" && !path.startsWith("node_modules/") || path.split("/").includes(".."))) process.exit(1);'
}
CACHE_LOCK="$LOCKS/production-dependencies/$CACHE_KEY"
ensure_private_directory "$CACHE_LOCK"
exec 9<"$CACHE_LOCK"
flock 9
if ! validate_cache; then
    if [ -e "$CACHE_ENTRY" ] || [ -L "$CACHE_ENTRY" ]; then
        echo "Rebuilding invalid production dependency cache: $CACHE_ENTRY" >&2
        rm -rf -- "$CACHE_ENTRY"
    fi
    npm --prefix "$CACHE_WORK" ci --omit=dev --include=optional --ignore-scripts=false --install-strategy=hoisted >&2
    [ -d "$CACHE_WORK/node_modules" ] || { echo "Production dependency install did not create node_modules" >&2; exit 1; }
    tar -czf "$CACHE_STAGING/node_modules.tar.gz" -C "$CACHE_WORK" node_modules
    ARCHIVE_SHA="$(sha256sum "$CACHE_STAGING/node_modules.tar.gz")"
    ARCHIVE_SHA="${ARCHIVE_SHA%% *}"
    printf '%s\narchiveSha256=%s\n' "$CACHE_METADATA" "$ARCHIVE_SHA" >"$CACHE_STAGING/manifest"
    rm -rf -- "$CACHE_WORK"
    mv "$CACHE_STAGING" "$CACHE_ENTRY"
    CACHE_STAGING=""
else
    rm -rf -- "$CACHE_STAGING"
    CACHE_STAGING=""
fi
STAGING="$(mktemp -d "$RELEASES/.staging.XXXXXX")"
cp -R "$ROOT/dist" "$STAGING/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGING/"
tar -xzf "$CACHE_ARCHIVE" -C "$STAGING"
[ -d "$STAGING/node_modules" ] || { echo "Production dependency cache did not contain node_modules" >&2; exit 1; }
mv "$STAGING" "$RELEASE"
STAGING=""
printf '%s\n' "$RELEASE"
