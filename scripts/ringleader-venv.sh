#!/usr/bin/env bash
# Builds a ringleader venv at $1 from the wheel $2.
set -euo pipefail
uv venv --quiet --python 3.13 "$1" >&2
uv pip install --quiet --python "$1/bin/python" "$2" >&2
