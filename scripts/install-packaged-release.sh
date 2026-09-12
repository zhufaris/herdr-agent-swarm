#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
for command_name in node npm systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "Missing required command: $command_name" >&2; exit 1; }
done
node "$ROOT/scripts/check-node-version.mjs"
test -r "$ROOT/dist/build-info.json"
test -d "$ROOT/node_modules"

CONFIG_DIR="${SWARM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm}"
STATE_DIR="${SWARM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm}"
ENV_FILE="$CONFIG_DIR/.env"
PROJECTS_FILE="$CONFIG_DIR/projects.json"
if [ ! -r "$ENV_FILE" ] || [ ! -r "$PROJECTS_FILE" ]; then
  echo "Configuration is missing. Run: SWARM_ROOT=$ROOT node $ROOT/dist/cli/setup.js" >&2
  exit 1
fi

readarray -t IDENTITY < <(node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!/^sha256:[a-f0-9]{64}$/.test(v.buildId)||!/^[a-f0-9]{40}$/.test(v.gitCommit)) process.exit(1); console.log(v.buildId.slice(7)); console.log(v.gitCommit.slice(0,12));' "$ROOT/dist/build-info.json")
RELEASE_KEY="${IDENTITY[0]}-${IDENTITY[1]}"
RELEASES="$STATE_DIR/releases"
RELEASE="$RELEASES/$RELEASE_KEY"
install -d -m 700 "$STATE_DIR" "$RELEASES"
if [ ! -d "$RELEASE" ]; then
  STAGING="$(mktemp -d "$RELEASES/.staging.XXXXXX")"
  trap 'rm -rf -- "$STAGING"' EXIT
  cp -R "$ROOT/dist" "$ROOT/node_modules" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/scripts" "$ROOT/config" "$ROOT/.env.example" "$ROOT/README.md" "$ROOT/LICENSE" "$ROOT/docs" "$STAGING/"
  mv "$STAGING" "$RELEASE"
  trap - EXIT
fi
SWARM_ROOT="$RELEASE" SWARM_RELEASE_CANDIDATE="$RELEASE" SWARM_CONFIG_DIR="$CONFIG_DIR" SWARM_STATE_DIR="$STATE_DIR" node "$RELEASE/dist/cli/service-lifecycle.js" install
echo "Herdr Agent Swarm release installed and enabled. Run npm run swarm:start from the release directory to start it."
