#!/bin/bash
set -euo pipefail

ENTRYPOINT="${1:-}"
PLACEMENT="${2:-zoomed}"
HERDR_COMMAND="${HERDR_BIN_PATH:-herdr}"

if [ -z "$ENTRYPOINT" ]; then
    echo "Missing plugin pane entrypoint" >&2
    exit 2
fi

args=(plugin pane open --plugin herdr-lark-bridge --entrypoint "$ENTRYPOINT" --placement "$PLACEMENT" --env "PATH=$PATH" --focus)
if [ -n "${HERDR_PANE_ID:-}" ]; then
    args+=(--target-pane "$HERDR_PANE_ID")
fi
exec "$HERDR_COMMAND" "${args[@]}"
