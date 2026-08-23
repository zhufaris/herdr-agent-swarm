#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$SCRIPT_DIR/common.sh"
ROOT="$(plugin_root)"
ENV_FILE="$(bridge_env_file)"
if [ -r "$ENV_FILE" ]; then export HERDR_BRIDGE_ENV_FILE="$ENV_FILE"; fi
exec node "$ROOT/dist/cli/relay-herdr-event.js"
