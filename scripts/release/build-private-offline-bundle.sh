#!/bin/bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
# shellcheck source=lib/bundle-common.sh
source "$REPOSITORY_ROOT/scripts/release/lib/bundle-common.sh"

HERDR_BIN="${HERDR_RELEASE_BIN:-}"
OUTPUT_DIR="$REPOSITORY_ROOT/release"
VALIDATE_ONLY=0

usage() {
  printf 'usage: %s --herdr-bin <path> [--output-dir <path>] [--validate-only]\n' "$0" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --herdr-bin)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then printf 'error: --herdr-bin requires a path\n' >&2; usage; exit 2; fi
      HERDR_BIN="$2"
      shift 2
      ;;
    --output-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then printf 'error: --output-dir requires a path\n' >&2; usage; exit 2; fi
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --validate-only) VALIDATE_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'error: unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$HERDR_BIN" ]; then
  printf 'error: --herdr-bin or HERDR_RELEASE_BIN is required\n' >&2
  usage
  exit 2
fi

bundle_require_linux_x64
bundle_validate_herdr "$HERDR_BIN"
printf 'Validated Herdr %s (%s, %s)\n' "$HERDR_RELEASE_VERSION" "$RELEASE_PLATFORM" "$HERDR_RELEASE_SHA256"

if [ "$VALIDATE_ONLY" -eq 1 ]; then exit 0; fi

for command_name in git node npm tar gzip sha256sum find sort install; do
  if ! command -v "$command_name" >/dev/null 2>&1; then bundle_die "required build command is unavailable: $command_name"; exit 1; fi
done

if ! git -C "$REPOSITORY_ROOT" diff --quiet -- \
  src scripts/release package.json package-lock.json tsconfig.json tsconfig.typecheck.json; then
  bundle_die "tracked release inputs are dirty; commit them before building"
  exit 1
fi

PRODUCT_VERSION="$(node -p "require('$REPOSITORY_ROOT/package.json').version")"
GIT_COMMIT="$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)"
SOURCE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$REPOSITORY_ROOT" show -s --format=%ct HEAD)}"
if ! [[ "$SOURCE_EPOCH" =~ ^[0-9]+$ ]]; then bundle_die "SOURCE_DATE_EPOCH must be a non-negative integer"; exit 1; fi
RELEASE_NAME="herdr-agent-swarm-$PRODUCT_VERSION-$RELEASE_PLATFORM"

BUILD_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/herdr-agent-swarm-release.XXXXXX")"
cleanup() { rm -rf -- "$BUILD_TEMP"; }
trap cleanup EXIT
PAYLOAD="$BUILD_TEMP/$RELEASE_NAME"
RUNTIME="$PAYLOAD/runtime"
mkdir -p "$PAYLOAD/bin" "$PAYLOAD/scripts/lib" "$PAYLOAD/templates" "$RUNTIME" "$BUILD_TEMP/npm-cache"

(cd "$REPOSITORY_ROOT" && npm run build)
BUILD_INFO="$REPOSITORY_ROOT/dist/build-info.json"
if [ ! -f "$BUILD_INFO" ]; then bundle_die "normal build did not generate dist/build-info.json"; exit 1; fi
BUILD_ID="$(node -e 'const x=require(process.argv[1]); if (!/^[a-f0-9]{64}$/.test(x.buildId)) process.exit(1); process.stdout.write(x.buildId)' "$BUILD_INFO")" || { bundle_die "invalid Swarm build identity"; exit 1; }
BUILD_GIT_COMMIT="$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.gitCommit || "")' "$BUILD_INFO")"
if [ "$BUILD_GIT_COMMIT" != "$GIT_COMMIT" ]; then bundle_die "Swarm build identity does not match Git commit $GIT_COMMIT"; exit 1; fi

install -m 755 "$HERDR_BIN" "$PAYLOAD/bin/herdr-real"
cp -R "$REPOSITORY_ROOT/dist" "$RUNTIME/dist"
install -m 644 "$REPOSITORY_ROOT/package.json" "$RUNTIME/package.json"
install -m 644 "$REPOSITORY_ROOT/package-lock.json" "$RUNTIME/package-lock.json"
npm --prefix "$RUNTIME" ci --omit=dev --ignore-scripts --cache "$BUILD_TEMP/npm-cache"

install -m 755 "$REPOSITORY_ROOT/scripts/release/swarmctl" "$PAYLOAD/scripts/swarmctl"
install -m 755 "$REPOSITORY_ROOT/scripts/release/lib/bundle-common.sh" "$PAYLOAD/scripts/lib/bundle-common.sh"
for template in herdr-headless.service herdr-agent-swarm.service; do
  install -m 644 "$REPOSITORY_ROOT/scripts/release/templates/$template" "$PAYLOAD/templates/$template"
done
install -m 600 "$REPOSITORY_ROOT/.env.example" "$PAYLOAD/templates/env.example"
install -m 600 "$REPOSITORY_ROOT/config/projects.example.json" "$PAYLOAD/templates/projects.example.json"
install -m 644 "$REPOSITORY_ROOT/scripts/release/README.bundle.md" "$PAYLOAD/README.md"
install -m 644 "$REPOSITORY_ROOT/LICENSE" "$PAYLOAD/LICENSE"
install -m 644 "$REPOSITORY_ROOT/scripts/release/THIRD_PARTY_NOTICES.md" "$PAYLOAD/THIRD_PARTY_NOTICES.md"

CREATED_AT="$(node -e 'process.stdout.write(new Date(Number(process.argv[1]) * 1000).toISOString())' "$SOURCE_EPOCH")"
node - "$PAYLOAD/release.json" "$PRODUCT_VERSION" "$GIT_COMMIT" "$BUILD_ID" "$CREATED_AT" <<'NODE'
const fs = require("node:fs");
const [path, version, gitCommit, buildId, createdAt] = process.argv.slice(2);
const release = {
  product: "herdr-agent-swarm", version, gitCommit, buildId, platform: "linux-x64",
  node: ">=22.12", herdrVersion: "0.7.5",
  herdrSha256: "3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253", createdAt
};
fs.writeFileSync(path, `${JSON.stringify(release, null, 2)}\n`, { mode: 0o644 });
NODE
bundle_write_manifest "$PAYLOAD"

find "$PAYLOAD" -type d -exec chmod 755 {} +
find "$PAYLOAD" -type f -exec chmod 644 {} +
chmod 755 "$PAYLOAD/bin/herdr-real" "$PAYLOAD/scripts/swarmctl" "$PAYLOAD/scripts/lib/bundle-common.sh"
chmod 600 "$PAYLOAD/templates/env.example" "$PAYLOAD/templates/projects.example.json"

mkdir -p "$OUTPUT_DIR"
ARCHIVE_TEMP="$BUILD_TEMP/$RELEASE_NAME.tar.gz"
tar --sort=name --format=gnu --mtime="@$SOURCE_EPOCH" --owner=0 --group=0 --numeric-owner \
  -C "$BUILD_TEMP" -cf - "$RELEASE_NAME" | gzip -n > "$ARCHIVE_TEMP"

VERIFY_ROOT="$BUILD_TEMP/verify extraction with spaces"
mkdir -p "$VERIFY_ROOT"
tar -xzf "$ARCHIVE_TEMP" -C "$VERIFY_ROOT"
"$VERIFY_ROOT/$RELEASE_NAME/scripts/swarmctl" verify

ARCHIVE="$OUTPUT_DIR/$RELEASE_NAME.tar.gz"
CHECKSUM="$ARCHIVE.sha256"
install -m 644 "$ARCHIVE_TEMP" "$ARCHIVE.tmp"
mv -f "$ARCHIVE.tmp" "$ARCHIVE"
(cd "$OUTPUT_DIR" && sha256sum "$(basename "$ARCHIVE")") > "$CHECKSUM.tmp"
mv -f "$CHECKSUM.tmp" "$CHECKSUM"
printf 'Created %s\nChecksum %s\n' "$ARCHIVE" "$CHECKSUM"
