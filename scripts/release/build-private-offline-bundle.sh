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

printf 'error: bundle assembly is not implemented yet (requested output: %s)\n' "$OUTPUT_DIR" >&2
exit 1
