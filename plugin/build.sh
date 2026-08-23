#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
ROOT="$(plugin_root)"

require_command node
require_command npm
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) { console.error(`Node.js 22.5+ required; found ${process.versions.node}`); process.exit(1); }'
npm --prefix "$ROOT" ci
npm --prefix "$ROOT" run build
test -r "$ROOT/dist/main.js"
test -r "$ROOT/dist/cli/validate-config.js"
test -r "$ROOT/dist/cli/relay-herdr-event.js"
echo "Herdr Lark Bridge plugin build complete. Run the setup action to configure the service."
