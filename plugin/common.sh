#!/bin/bash

PLUGIN_ID="herdr-lark-bridge"

plugin_root() {
    if [ -n "${HERDR_PLUGIN_ROOT:-}" ]; then
        (cd "$HERDR_PLUGIN_ROOT" && pwd -P)
        return
    fi
    (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
}

plugin_config_dir() {
    if [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ]; then
        printf '%s\n' "$HERDR_PLUGIN_CONFIG_DIR"
        return
    fi
    printf '%s/herdr/plugins/config/%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}" "$PLUGIN_ID"
}

plugin_state_dir() {
    if [ -n "${HERDR_PLUGIN_STATE_DIR:-}" ]; then
        printf '%s\n' "$HERDR_PLUGIN_STATE_DIR"
        return
    fi
    printf '%s/herdr/plugins/state/%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}" "$PLUGIN_ID"
}

bridge_env_file() {
    printf '%s/.env\n' "$(plugin_config_dir)"
}

projects_file() {
    printf '%s/projects.json\n' "$(plugin_config_dir)"
}

bridge_database() {
    printf '%s/bridge.db\n' "$(plugin_state_dir)"
}

ensure_private_config_dir() {
    local directory
    directory="$(plugin_config_dir)"
    mkdir -p "$directory"
    chmod 700 "$directory"
    directory="$(plugin_state_dir)"
    mkdir -p "$directory"
    chmod 700 "$directory"
}

require_command() {
    local name="$1"
    if ! command -v "$name" >/dev/null 2>&1; then
        echo "Missing required command: $name" >&2
        return 1
    fi
}

resolve_command() {
    local name="$1"
    command -v "$name" 2>/dev/null || { echo "Missing required command: $name" >&2; return 1; }
}

require_setup() {
    local env_file projects
    env_file="$(bridge_env_file)"
    projects="$(projects_file)"
    if [ ! -r "$env_file" ] || [ ! -r "$projects" ]; then
        echo "Bridge configuration is incomplete. Run the setup plugin action first." >&2
        return 1
    fi
}

validate_configuration() {
    local root env_file projects node_bin
    root="$(plugin_root)"
    env_file="$(bridge_env_file)"
    projects="$(projects_file)"
    node_bin="${NODE_BIN:-$(resolve_command node)}"
    "$node_bin" "$root/dist/cli/validate-config.js" "$env_file" "$projects"
}

pause_if_interactive() {
    if [ -t 0 ]; then
        printf '\nPress Enter to close...'
        read -r _
    fi
}
