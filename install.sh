#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"

usage() {
    cat <<'EOF'
Usage: ./install.sh

Build, stage, install, and enable herdr-agent-swarm.service.

Options:
  -h, --help
           Show this help.
EOF
}

case "${1:-}" in
    "") ;;
    -h|--help) usage; exit 0 ;;
    --setup|--standalone|--compat-plugin)
        echo "Herdr plugin installation has been removed. Run npm run build && npm run swarm:setup, then ./install.sh." >&2
        exit 2
        ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then echo "No arguments are supported." >&2; usage >&2; exit 2; fi

for command_name in node npm; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Missing required command: $command_name" >&2
        exit 1
    fi
done
node "$ROOT/scripts/check-node-version.mjs"

npm ci
npm run build
STATE_DIR="${SWARM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm}"
SWARM_RUNTIME_ROOT="$(bash "$ROOT/scripts/stage-production-runtime.sh" "$STATE_DIR")"
CONFIG_DIR="${SWARM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm}"
ENV_FILE="$CONFIG_DIR/.env"
PROJECTS_FILE="$CONFIG_DIR/projects.json"
CONFIGURATION_INCOMPLETE=0
if [ ! -f "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ] || [ ! -f "$PROJECTS_FILE" ] || [ ! -r "$PROJECTS_FILE" ]; then
    CONFIGURATION_INCOMPLETE=1
else
    for placeholder in "replace-me" "REPLACE_WITH_HERDR_WORKSPACE_ID" "/absolute/path/to/your/project"; do
        if grep -Fq -- "$placeholder" "$ENV_FILE" "$PROJECTS_FILE"; then
            CONFIGURATION_INCOMPLETE=1
            break
        fi
    done
fi
if [ "$CONFIGURATION_INCOMPLETE" -eq 1 ]; then
    echo "Configuration is missing or still contains placeholders. Run: npm run swarm:setup" >&2
    exit 1
fi

SWARM_ROOT="$SWARM_RUNTIME_ROOT" SWARM_RELEASE_CANDIDATE="$SWARM_RUNTIME_ROOT" SWARM_CONFIG_DIR="$CONFIG_DIR" SWARM_STATE_DIR="$STATE_DIR" \
    node "$SWARM_RUNTIME_ROOT/dist/cli/service-lifecycle.js" install
echo "Herdr Agent Swarm service installed and enabled."
