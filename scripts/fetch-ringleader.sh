#!/usr/bin/env bash
# Stages the ringleader release pinned in ringleader.json into .cache/ringleader/<version>/ and prints that directory.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
manifest="$repo_root/ringleader.json"
repository="$(jq -r .repository "$manifest")"
version="$(jq -r .latest "$manifest")"
wheel="$(jq -r .wheel "$manifest")"
pinned="$(jq -r .sha256 "$manifest")"
dir="$repo_root/.cache/ringleader/$version"

if [ ! -x "$dir/venv/bin/rl" ]; then
  [ "${#pinned}" -eq 64 ] || { echo "ringleader.json has no sha256 for $version; run: just pin-ringleader $version" >&2; exit 1; }
  rm -rf "$dir.partial"
  mkdir -p "$dir.partial"
  gh release download "v$version" --repo "$repository" --dir "$dir.partial" \
    --pattern "$wheel" --pattern contract-golden.tar.gz --pattern SHA256SUMS >&2
  actual="$(shasum -a 256 "$dir.partial/$wheel" | cut -d' ' -f1)"
  [ "$actual" = "$pinned" ] || { echo "fetch-ringleader: $wheel does not match the pinned sha256" >&2; exit 1; }
  (cd "$dir.partial" && shasum -a 256 -c SHA256SUMS >&2)
  rm -rf "$dir"
  mv "$dir.partial" "$dir"
  # venv scripts embed their interpreter's absolute path, so build it where it will stay
  "$repo_root/scripts/ringleader-venv.sh" "$dir/venv" "$dir/$wheel"
fi
printf '%s\n' "$dir"
