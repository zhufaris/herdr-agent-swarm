#!/usr/bin/env bash
set -euo pipefail

# Installation replaces all three tokens with shell-quoted absolute paths.
real_herdr=@HERDR_TRAEX_REAL_HERDR@
node_bin=@HERDR_TRAEX_NODE@
shim_entrypoint=@HERDR_TRAEX_ENTRYPOINT@
shim_config=@HERDR_TRAEX_CONFIG@

intercept=0
if [[ ${1:-} == agent && ${2:-} == start ]]; then
  for ((index = 3; index <= $#; index++)); do
    [[ ${!index} == -- ]] && break
    if [[ ${!index} == --kind ]]; then
      next=$((index + 1))
      [[ $next -le $# && ${!next} == traex ]] && intercept=1
    fi
  done
fi

if (( intercept )); then
  HERDR_TRAEX_SHIM_CONFIG=$shim_config exec "$node_bin" "$shim_entrypoint" "$@"
fi
exec "$real_herdr" "$@"
