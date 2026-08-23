#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$SCRIPT_DIR/common.sh"
ACTION="${1:-}"
case "$ACTION" in install|uninstall|start|status|restart|stop|logs) ;; *) echo "usage: service.sh <install|uninstall|start|status|restart|stop|logs>" >&2; exit 2 ;; esac
ROOT="$(plugin_root)"
export HERDR_PLUGIN_ROOT="$ROOT"
export HERDR_PLUGIN_CONFIG_DIR="$(plugin_config_dir)"
export HERDR_PLUGIN_STATE_DIR="$(plugin_state_dir)"
ensure_private_config_dir
exec node "$ROOT/dist/cli/plugin-lifecycle.js" "$ACTION"
