#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
ACTION="${1:-}"
CONFIG_DIR="${SOLO_AGENT_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/solo-agent}"
STATE_DIR="${SOLO_AGENT_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/solo-agent}"
SERVICE_NAME="${BRIDGE_SYSTEMD_SERVICE_NAME:-solo-agent.service}"

case "$ACTION" in
  init)
    install -d -m 700 "$CONFIG_DIR" "$STATE_DIR"
    if [ ! -e "$CONFIG_DIR/.env" ]; then install -m 600 "$ROOT/.env.example" "$CONFIG_DIR/.env"; fi
    if [ ! -e "$CONFIG_DIR/projects.json" ]; then install -m 600 "$ROOT/config/projects.example.json" "$CONFIG_DIR/projects.json"; fi
    printf 'Created private standalone configuration in %s\nEdit .env and projects.json, then run: npm run solo:install\n' "$CONFIG_DIR"
    exit 0
    ;;
  install|uninstall|start|status|restart|stop|logs) ;;
  *) printf 'usage: %s <init|install|uninstall|start|status|restart|stop|logs>\n' "$0" >&2; exit 2 ;;
esac

export SOLO_AGENT_ROOT="$ROOT"
export SOLO_AGENT_CONFIG_DIR="$CONFIG_DIR"
export SOLO_AGENT_STATE_DIR="$STATE_DIR"
export BRIDGE_SYSTEMD_SERVICE_NAME="$SERVICE_NAME"
exec node "$ROOT/dist/cli/plugin-lifecycle.js" "$ACTION"
