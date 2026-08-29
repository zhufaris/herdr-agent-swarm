#!/usr/bin/env bash
set -euo pipefail

request_dir=@HERDR_TRAEX_REQUEST_DIR@
request_id=${1:-}
[[ $request_id =~ ^[a-f0-9-]+$ ]] || { echo "invalid TraeX request ID" >&2; exit 2; }
request_path="$request_dir/$request_id"
[[ -f $request_path && ! -L $request_path ]] || { echo "TraeX request not found" >&2; exit 1; }

values=()
while IFS= read -r -d '' value; do values+=("$value"); done < "$request_path"
rm -f -- "$request_path"
(( ${#values[@]} >= 1 )) || { echo "empty TraeX request" >&2; exit 1; }
executable=${values[0]}
args=("${values[@]:1}")
exec -- "$executable" "${args[@]}"
