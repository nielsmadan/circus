#!/usr/bin/env bash
# Builds release-shaped ringleader assets from a checkout, for contract changes not yet released; prints the directory.
set -euo pipefail
checkout="$(cd "$1" && pwd -P)"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
dir="$repo_root/.cache/ringleader/checkout"
rm -rf "$dir"
mkdir -p "$dir"
(cd "$checkout" && uv run python scripts/hooklinesinker.py vendor >&2 && uv build --wheel --out-dir "$dir" >&2)
tar -czf "$dir/contract-golden.tar.gz" -C "$checkout/tests/golden" $(cd "$checkout/tests/golden" && ls contract-*.json)
"$repo_root/scripts/ringleader-venv.sh" "$dir/venv" "$dir"/ringleader-*.whl
printf '%s\n' "$dir"
