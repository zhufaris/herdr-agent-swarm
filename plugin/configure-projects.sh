#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$SCRIPT_DIR/common.sh"
ensure_private_config_dir
PROJECTS="$(projects_file)"
ROOT="$(plugin_root)"
if [ ! -e "$PROJECTS" ]; then install -m 600 "$ROOT/config/projects.example.json" "$PROJECTS"; fi
DRAFT="$(mktemp "$(plugin_config_dir)/projects.draft.XXXXXX")"
trap 'rm -f "$DRAFT"' EXIT
cp "$PROJECTS" "$DRAFT"
chmod 600 "$DRAFT"
EDITOR_COMMAND="${EDITOR:-vim}"
"$EDITOR_COMMAND" "$DRAFT"
"${NODE_BIN:-$(resolve_command node)}" "$ROOT/dist/cli/validate-config.js" "$(bridge_env_file)" "$DRAFT"
mv -f "$DRAFT" "$PROJECTS"
trap - EXIT
bash "$SCRIPT_DIR/service.sh" restart
