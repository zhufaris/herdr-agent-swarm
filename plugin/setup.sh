#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$SCRIPT_DIR/common.sh"
ensure_private_config_dir
ROOT="$(plugin_root)"
ENV_FILE="$(bridge_env_file)"
PROJECTS="$(projects_file)"
ENV_DRAFT="$(mktemp "$(plugin_config_dir)/.env.draft.XXXXXX")"
PROJECTS_DRAFT="$(mktemp "$(plugin_config_dir)/projects.draft.XXXXXX")"
trap 'rm -f "$ENV_DRAFT" "$PROJECTS_DRAFT"' EXIT
if [ -e "$ENV_FILE" ]; then cp "$ENV_FILE" "$ENV_DRAFT"; else cp "$ROOT/.env.example" "$ENV_DRAFT"; fi
if [ -e "$PROJECTS" ]; then cp "$PROJECTS" "$PROJECTS_DRAFT"; else cp "$ROOT/config/projects.json" "$PROJECTS_DRAFT"; fi
chmod 600 "$ENV_DRAFT" "$PROJECTS_DRAFT"
EDITOR_COMMAND="${EDITOR:-vim}"
printf 'Editing private bridge environment: %s\n' "$ENV_FILE"
"$EDITOR_COMMAND" "$ENV_DRAFT"
printf 'Editing project registry: %s\n' "$PROJECTS"
"$EDITOR_COMMAND" "$PROJECTS_DRAFT"
"${NODE_BIN:-$(resolve_command node)}" "$ROOT/dist/cli/validate-config.js" "$ENV_DRAFT" "$PROJECTS_DRAFT"
mv -f "$ENV_DRAFT" "$ENV_FILE"
mv -f "$PROJECTS_DRAFT" "$PROJECTS"
trap - EXIT
"$SCRIPT_DIR/service.sh" install
"$SCRIPT_DIR/service.sh" restart
pause_if_interactive
