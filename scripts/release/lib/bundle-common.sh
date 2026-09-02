#!/bin/bash

HERDR_RELEASE_VERSION="0.7.5"
HERDR_RELEASE_SHA256="3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253"
RELEASE_PLATFORM="linux-x64"

bundle_die() {
  printf 'error: %s\n' "$*" >&2
  return 1
}

bundle_require_linux_x64() {
  local kernel machine
  kernel="$(uname -s)"
  machine="$(uname -m)"
  if [ "$kernel" != "Linux" ] || { [ "$machine" != "x86_64" ] && [ "$machine" != "amd64" ]; }; then
    bundle_die "unsupported build host $kernel/$machine; expected Linux/x86-64"
  fi
}

bundle_validate_herdr() {
  local herdr_bin="$1" file_description machine version digest
  if [ ! -f "$herdr_bin" ]; then
    bundle_die "Herdr binary does not exist: $herdr_bin"
    return
  fi
  if [ ! -x "$herdr_bin" ]; then
    bundle_die "Herdr binary is not executable: $herdr_bin"
    return
  fi
  file_description="$(file -b "$herdr_bin")" || return
  if [[ "$file_description" != ELF* ]]; then
    bundle_die "Herdr binary must be an ELF executable"
    return
  fi
  machine="$(readelf -h "$herdr_bin" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')" || return
  if [ "$machine" != "Advanced Micro Devices X86-64" ]; then
    bundle_die "Herdr binary must target x86-64; found ${machine:-unknown}"
    return
  fi
  version="$("$herdr_bin" --version 2>/dev/null)" || {
    bundle_die "Herdr binary did not report a version"
    return
  }
  if [ "$version" != "herdr $HERDR_RELEASE_VERSION" ]; then
    bundle_die "Herdr version must be $HERDR_RELEASE_VERSION; found ${version:-unknown}"
    return
  fi
  digest="$(sha256sum "$herdr_bin")" || return
  digest="${digest%% *}"
  if [ "$digest" != "$HERDR_RELEASE_SHA256" ]; then
    bundle_die "Herdr SHA-256 mismatch: expected $HERDR_RELEASE_SHA256, found $digest"
    return
  fi
}

bundle_regular_files() {
  local root="$1"
  (
    cd "$root"
    find . -type f ! -path './MANIFEST.sha256' -print | LC_ALL=C sort
  )
}

bundle_write_manifest() {
  local root="$1" path
  : > "$root/MANIFEST.sha256"
  while IFS= read -r path; do
    if [[ "$path" == *$'\n'* ]] || [[ "$path" == *\\* ]]; then
      bundle_die "unsupported payload path: $path"
      return
    fi
    (cd "$root" && sha256sum "$path") >> "$root/MANIFEST.sha256"
  done < <(bundle_regular_files "$root")
}

bundle_verify_manifest() {
  local root="$1" manifest="$1/MANIFEST.sha256" expected actual link target resolved
  if [ ! -f "$manifest" ]; then
    bundle_die "manifest is missing"
    return
  fi
  expected="$(sed -n 's/^[0-9a-f]\{64\}  //p' "$manifest")"
  actual="$(bundle_regular_files "$root")"
  if [ "$expected" != "$actual" ]; then
    bundle_die "manifest file coverage does not match the payload"
    return
  fi
  if ! (cd "$root" && sha256sum --check --strict MANIFEST.sha256 >/dev/null); then
    bundle_die "manifest checksum verification failed"
    return
  fi
  while IFS= read -r link; do
    target="$(readlink "$link")"
    resolved="$(realpath -m "$(dirname "$link")/$target")"
    case "$resolved" in
      "$root"|"$root"/*) ;;
      *) bundle_die "payload symlink escapes bundle root: ${link#"$root/"}"; return ;;
    esac
  done < <(find "$root" -type l -print)
}
