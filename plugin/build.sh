#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
ROOT="$(plugin_root)"

require_command node
require_command npm
node "$ROOT/scripts/check-node-version.mjs"
npm --prefix "$ROOT" ci
npm --prefix "$ROOT" run build
test -r "$ROOT/dist/main.js"
test -r "$ROOT/dist/build-info.json"
test -r "$ROOT/dist/cli/validate-config.js"
test -r "$ROOT/dist/cli/relay-herdr-event.js"
echo "Herdr Lark Bridge plugin build complete. Run the setup action to configure the service."
