#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$SCRIPT_DIR/common.sh"
ACTION="${1:-}"
FORCE="${2:-}"
case "$ACTION" in install|uninstall|start|status|restart|stop|logs) ;; *) echo "usage: service.sh <install|uninstall|start|status|restart|stop|logs> [--force for restart]" >&2; exit 2 ;; esac
if { [ -n "$FORCE" ] && { [ "$ACTION" != "restart" ] || [ "$FORCE" != "--force" ]; }; } || [ "$#" -gt 2 ]; then
    echo "usage: service.sh <install|uninstall|start|status|restart|stop|logs> [--force for restart]" >&2
    exit 2
fi
ROOT="$(plugin_root)"
export HERDR_PLUGIN_ROOT="$ROOT"
export HERDR_PLUGIN_CONFIG_DIR="$(plugin_config_dir)"
export HERDR_PLUGIN_STATE_DIR="$(plugin_state_dir)"
ensure_private_config_dir
args=("$ROOT/dist/cli/plugin-lifecycle.js" "$ACTION")
if [ -n "$FORCE" ]; then args+=("$FORCE"); fi
exec node "${args[@]}"
