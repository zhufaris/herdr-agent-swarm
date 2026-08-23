#!/bin/bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$SCRIPT_DIR/common.sh"
"$SCRIPT_DIR/service.sh" logs
RESULT=$?
pause_if_interactive
exit "$RESULT"
