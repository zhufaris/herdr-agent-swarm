#!/bin/bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
ACTION="${1:-}"
FORCE="${2:-}"
CONFIG_DIR="${SWARM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm}"
STATE_DIR="${SWARM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm}"
SERVICE_NAME="${BRIDGE_SYSTEMD_SERVICE_NAME:-herdr-agent-swarm.service}"
ROOT="$SOURCE_ROOT"
if [ -L "$STATE_DIR/current" ]; then ROOT="$(readlink -f "$STATE_DIR/current")"; fi
export SWARM_ROOT="$ROOT"
export SWARM_CONFIG_DIR="$CONFIG_DIR"
export SWARM_STATE_DIR="$STATE_DIR"
export BRIDGE_SYSTEMD_SERVICE_NAME="$SERVICE_NAME"

case "$ACTION" in
  setup) exec node "$ROOT/dist/cli/setup.js" "${@:2}" ;;
  doctor) exec node "$ROOT/dist/cli/doctor.js" "${@:2}" ;;
  init)
    install -d -m 700 "$CONFIG_DIR" "$STATE_DIR"
    if [ ! -e "$CONFIG_DIR/.env" ]; then install -m 600 "$SOURCE_ROOT/.env.example" "$CONFIG_DIR/.env"; fi
    if [ ! -e "$CONFIG_DIR/projects.json" ]; then install -m 600 "$SOURCE_ROOT/config/projects.example.json" "$CONFIG_DIR/projects.json"; fi
    printf 'Created private Herdr Agent Swarm configuration in %s\nEdit .env and projects.json, then run: npm run swarm:install\n' "$CONFIG_DIR"
    exit 0
    ;;
  migrate)
    if [ "$#" -gt 1 ]; then printf 'usage: %s migrate\n' "$0" >&2; exit 2; fi
    exec node "$SOURCE_ROOT/dist/cli/swarm-service-cutover.js"
    ;;
  install|uninstall|start|status|restart|stop|logs) ;;
  *) printf 'usage: %s <setup|doctor|init|migrate|install|uninstall|start|status|restart|stop|logs> [options]\n' "$0" >&2; exit 2 ;;
esac
if { [ -n "$FORCE" ] && { [ "$ACTION" != "restart" ] || [ "$FORCE" != "--force" ]; }; } || [ "$#" -gt 2 ]; then
  printf 'usage: %s <init|migrate|install|uninstall|start|status|restart|stop|logs> [--force for restart]\n' "$0" >&2
  exit 2
fi

args=("$ROOT/dist/cli/plugin-lifecycle.js" "$ACTION")
if [ -n "$FORCE" ]; then args+=("$FORCE"); fi
exec node "${args[@]}"
