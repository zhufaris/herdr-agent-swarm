#!/usr/bin/env bash
set -euo pipefail

action=${1:-}
shift || true
bin_dir=${HERDR_TRAEX_SHIM_BIN_DIR:-}
accept_version=0
while (($#)); do
  case $1 in
    --bin-dir) bin_dir=${2:-}; shift 2 ;;
    --accept-version) accept_version=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

source_root=${HERDR_TRAEX_SHIM_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
data_root=${XDG_DATA_HOME:-$HOME/.local/share}/herdr-traex-shim
config_root=${XDG_CONFIG_HOME:-$HOME/.config}/herdr-traex-shim
state_root=${XDG_STATE_HOME:-$HOME/.local/state}/herdr-traex-shim
config_path=$config_root/config.json
if [[ -n ${XDG_RUNTIME_DIR:-} ]]; then request_dir=$XDG_RUNTIME_DIR/herdr-traex-shim/run; else request_dir=$state_root/run; fi

fail() { echo "herdr-traex-shim: $*" >&2; exit 1; }
usage() { echo "usage: $0 <install|status|uninstall> [--bin-dir <absolute-path>] [--accept-version]" >&2; exit 2; }
is_absolute() { [[ $1 == /* ]]; }

resolve_real() {
  local candidate=${HERDR_TRAEX_REAL_HERDR:-}
  if [[ -z $candidate ]]; then
    candidate=$(command -v herdr || true)
  fi
  [[ -n $candidate ]] || fail "real Herdr binary not found"
  readlink -f -- "$candidate"
}

resolve_traex() {
  local candidate=${HERDR_TRAEX_BIN:-}
  if [[ -z $candidate ]]; then candidate=$(command -v traex || true); fi
  [[ -n $candidate ]] || fail "TraeX binary not found"
  readlink -f -- "$candidate"
}

resolve_session_peers_dir() {
  local traex_home
  if [[ -n ${HERDR_TRAEX_HOME:-} ]]; then
    traex_home=$HERDR_TRAEX_HOME
  elif [[ -n ${TRAECLI_HOME:-} ]]; then
    traex_home=$TRAECLI_HOME
  else
    traex_home=$HOME/.trae/cli
  fi
  [[ -n $traex_home ]] || fail "TraeX home is empty"
  readlink -m -- "$traex_home/session-peers"
}

path_index() {
  local wanted=$1 index=0 entry
  IFS=: read -r -a entries <<< "$PATH"
  for entry in "${entries[@]}"; do
    [[ $(readlink -m -- "${entry:-.}") == $(readlink -m -- "$wanted") ]] && { echo "$index"; return; }
    index=$((index + 1))
  done
  echo -1
}

write_config() {
  local output=$1 real_herdr=$2 traex=$3 version=$4 release=$5 session_peers_dir=$6
  node -e 'const fs=require("fs"); const [p,r,t,v,b,d,q,s,o]=process.argv.slice(1); fs.writeFileSync(p, JSON.stringify({realHerdr:r,traex:t,validatedHerdrVersion:v,releaseDir:b,binDir:d,launcher:b+"/pane-launcher",reporter:b+"/cli/herdr-traex-reporter.js",requestDir:q,sessionPeersDir:s,steeringOperationDir:o},null,2)+"\n",{mode:0o600})' "$output" "$real_herdr" "$traex" "$version" "$release" "$bin_dir" "$request_dir" "$session_peers_dir" "$state_root/steering-operations"
}

read_config() { node -e 'const c=require(process.argv[1]); console.log(c[process.argv[2]] ?? "")' "$config_path" "$1"; }
validate_contract() {
  local real_herdr=$1 schema report_session_help
  report_session_help=$("$real_herdr" pane report-agent-session --help)
  [[ $report_session_help == *--agent-session-id* ]] || fail "Herdr pane report-agent-session lacks --agent-session-id"
  [[ $report_session_help == *--session-start-source* ]] || fail "Herdr pane report-agent-session lacks --session-start-source"
  "$real_herdr" pane release-agent --help >/dev/null
  schema=$("$real_herdr" api schema --json)
  [[ $schema == *pane.report_agent* && $schema == *pane.report_agent_session* && $schema == *pane.report_metadata* && $schema == *pane.release_agent* ]] || fail "Herdr socket schema lacks reporter lifecycle methods"
}

case $action in
  install)
    [[ -n $bin_dir ]] || { echo "herdr-traex-shim: an explicit absolute bin directory is required" >&2; exit 2; }
    is_absolute "$bin_dir" || { echo "herdr-traex-shim: an explicit absolute bin directory is required" >&2; exit 2; }
    real_herdr=$(resolve_real); traex=$(resolve_traex); session_peers_dir=$(resolve_session_peers_dir)
    [[ -x $real_herdr ]] || fail "real Herdr is not executable"
    [[ -x $traex ]] || fail "TraeX is not executable"
    [[ $real_herdr != "$bin_dir/herdr" ]] || fail "shim recursion detected"
    shim_index=$(path_index "$bin_dir"); real_index=$(path_index "$(dirname "$real_herdr")")
    (( shim_index >= 0 )) || fail "shim bin directory must be present in PATH"
    (( real_index >= 0 && shim_index < real_index )) || fail "shim bin directory must precede the real Herdr directory in PATH"
    target=$bin_dir/herdr
    if [[ -e $target || -L $target ]]; then
      owned=0
      if [[ -L $target ]]; then [[ $(readlink -f -- "$target") == "$(readlink -m -- "$data_root")"/releases/*/herdr ]] && owned=1; fi
      (( owned )) || fail "refusing to replace unrelated $target"
    fi
    [[ ${HERDR_TRAEX_SKIP_BUILD:-0} == 1 ]] || (cd "$source_root" && npm run build)
    assets=(dist/cli/herdr-traex-shim.js dist/cli/herdr-traex-reporter.js dist/runtime/herdr-traex-shim.js dist/runtime/herdr-traex-reporter.js dist/runtime/traex-session-peer.js dist/runtime/traex-native-steering.js dist/runtime/traex-prompt-settlement.js dist/runtime/traex-model-protocol.js dist/runtime/traex-model-prompt.js scripts/herdr-traex-command-shim.sh scripts/herdr-traex-pane-launcher.sh)
    for file in "${assets[@]}"; do
      [[ -f $source_root/$file ]] || fail "missing built shim asset: $file"
    done
    herdr_version=$($real_herdr --version | sed -E 's/^[^0-9]*//')
    traex_version=$($traex --version | sed -E 's/^[^0-9]*//')
    [[ -n $herdr_version && -n $traex_version ]] || fail "could not determine Herdr or TraeX version"
    validate_contract "$real_herdr"
    asset_paths=(); for file in "${assets[@]}"; do asset_paths+=("$source_root/$file"); done
    build_id=$(sha256sum "${asset_paths[@]}" | sha256sum | cut -c1-16)
    release=$data_root/releases/$build_id
    mkdir -p "$release/cli" "$release/runtime" "$config_root" "$request_dir" "$state_root/steering-operations" "$bin_dir"
    chmod 700 "$config_root" "$request_dir" "$state_root/steering-operations"
    cp "$source_root/dist/cli/herdr-traex-shim.js" "$source_root/dist/cli/herdr-traex-reporter.js" "$release/cli/"
    cp "$source_root/dist/runtime/herdr-traex-shim.js" "$source_root/dist/runtime/herdr-traex-reporter.js" "$source_root/dist/runtime/traex-session-peer.js" "$source_root/dist/runtime/traex-native-steering.js" "$release/runtime/"
    cp "$source_root/dist/runtime/traex-prompt-settlement.js" "$source_root/dist/runtime/traex-model-protocol.js" "$source_root/dist/runtime/traex-model-prompt.js" "$release/runtime/"
    cp "$source_root/scripts/herdr-traex-command-shim.sh" "$release/herdr"
    cp "$source_root/scripts/herdr-traex-pane-launcher.sh" "$release/pane-launcher"
    printf '{"type":"module"}\n' > "$release/package.json"
    { printf 'real_herdr=%q\n' "$real_herdr"; printf 'node_bin=%q\n' "$(command -v node)"; printf 'shim_entrypoint=%q\n' "$release/cli/herdr-traex-shim.js"; printf 'shim_config=%q\n' "$release/config.json"; printf 'request_dir=%q\n' "$request_dir"; printf 'validated_herdr_version=%q\n' "$herdr_version"; } > "$release/paths.sh"
    chmod 755 "$release/herdr" "$release/pane-launcher"; chmod 600 "$release/paths.sh"
    write_config "$release/config.json" "$real_herdr" "$traex" "$herdr_version" "$release" "$session_peers_dir"
    chmod 600 "$release/config.json"
    config_tmp=$config_path.tmp.$$; write_config "$config_tmp" "$real_herdr" "$traex" "$herdr_version" "$release" "$session_peers_dir"; mv -f "$config_tmp" "$config_path"
    link_tmp=$bin_dir/.herdr-traex-shim.$$; ln -s "$release/herdr" "$link_tmp"; mv -Tf "$link_tmp" "$target"
    echo "installed: $release"; echo "herdr: $herdr_version"; echo "traex: $traex_version"
    ;;
  status)
    [[ -f $config_path ]] || { echo "status: not installed"; exit 0; }
    real_herdr=$(read_config realHerdr); validated=$(read_config validatedHerdrVersion); release=$(read_config releaseDir); bin_dir=$(read_config binDir); traex=$(read_config traex); session_peers_dir=$(read_config sessionPeersDir)
    current=$($real_herdr --version | sed -E 's/^[^0-9]*//')
    if [[ $current != "$validated" ]]; then
      if (( accept_version )); then
        validate_contract "$real_herdr"
        config_tmp=$config_path.tmp.$$; write_config "$config_tmp" "$real_herdr" "$traex" "$current" "$release" "$session_peers_dir"; mv -f "$config_tmp" "$config_path"; validated=$current
        cp "$config_path" "$release/config.json"
        paths_tmp=$release/paths.sh.tmp.$$; sed -E "s/^validated_herdr_version=.*/validated_herdr_version=$(printf '%q' "$current")/" "$release/paths.sh" > "$paths_tmp"; chmod 600 "$paths_tmp"; mv -f "$paths_tmp" "$release/paths.sh"
      else fail "Herdr version mismatch: validated $validated, current $current; run status --accept-version after compatibility checks"; fi
    fi
    [[ -L $bin_dir/herdr && $(readlink -f -- "$bin_dir/herdr") == $(readlink -f -- "$release/herdr") ]] || fail "shim link is missing or inconsistent"
    [[ -x $traex ]] || fail "configured TraeX binary is unavailable"
    echo "status: ready"; echo "release: $(basename "$release")"; echo "herdr: $validated"; echo "traex: $($traex --version | sed -E 's/^[^0-9]*//')"
    ;;
  uninstall)
    [[ -f $config_path ]] || { echo "status: not installed"; exit 0; }
    bin_dir=$(read_config binDir); release=$(read_config releaseDir)
    target=$bin_dir/herdr
    if [[ -L $target && $(readlink -f -- "$target") == $(readlink -f -- "$release/herdr") ]]; then rm -f -- "$target"; fi
    rm -f -- "$config_path"
    echo "uninstalled: shim link and active config removed; releases retained for rollback"
    ;;
  *) usage ;;
esac
