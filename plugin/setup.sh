#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$SCRIPT_DIR/common.sh"
ensure_private_config_dir
ROOT="$(plugin_root)"
export HERDR_PLUGIN_ROOT="$ROOT"
export HERDR_PLUGIN_CONFIG_DIR="$(plugin_config_dir)"
export HERDR_PLUGIN_STATE_DIR="$(plugin_state_dir)"
exec "${NODE_BIN:-$(resolve_command node)}" "$ROOT/dist/cli/setup.js"
