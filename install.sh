#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
PLUGIN_ID="herdr-lark-bridge"
RUN_SETUP=0
STANDALONE=0

usage() {
    cat <<'EOF'
Usage: ./install.sh [--setup|--standalone]

Build, link, enable, and verify the Herdr Lark Bridge plugin.

Options:
  --setup  Open the interactive setup action after installation. This validates
           configuration, installs the systemd user service, and starts it.
  --standalone
           Build and install herdr-agent-swarm.service without linking a Herdr plugin.
  -h, --help
           Show this help.
EOF
}

case "${1:-}" in
    "") ;;
    --setup) RUN_SETUP=1 ;;
    --standalone) STANDALONE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then echo "Only one option is supported." >&2; usage >&2; exit 2; fi

for command_name in node npm herdr; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Missing required command: $command_name" >&2
        exit 1
    fi
done

if [ "$STANDALONE" -eq 1 ]; then
    npm ci
    npm run build
    bash "$ROOT/scripts/swarm-service.sh" install
    echo "Standalone service installed. Run 'npm run swarm:start' after configuration is ready."
    exit 0
fi

bash "$ROOT/plugin/build.sh"
herdr plugin link "$ROOT" --enabled

installed="$(herdr plugin list --json | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const plugins = JSON.parse(input)?.result?.plugins ?? [];
  const plugin = plugins.find(item => item.plugin_id === "herdr-lark-bridge");
  if (!plugin || plugin.enabled !== true) process.exit(1);
  process.stdout.write(`${plugin.plugin_id} ${plugin.version} enabled`);
});
' )"
echo "Verified: $installed"

if [ "$RUN_SETUP" -eq 1 ]; then
    herdr plugin action invoke setup --plugin "$PLUGIN_ID"
else
    echo "Plugin installed without changing bridge configuration or service state."
    echo "Run './install.sh --setup' when you are ready to configure and start the service."
fi
