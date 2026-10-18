#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/rl/scripts" "$T/rl/.venv/bin" "$T/bin" "$T/work" "$T/empty" "$T/norl/scripts" "$T/norl/.venv/bin" "$T/it's/scripts" "$T/it's/.venv/bin"
: > "$T/rl/scripts/gui_world.py"
: > "$T/norl/scripts/gui_world.py"
: > "$T/it's/scripts/gui_world.py"
printf '#!/bin/sh\nexit 0\n' > "$T/it's/.venv/bin/rl"
chmod +x "$T/it's/.venv/bin/rl"
printf '#!/bin/sh\nexit 0\n' > "$T/norl/.venv/bin/rl"
printf '#!/bin/sh\nexit 0\n' > "$T/rl/.venv/bin/rl"
chmod +x "$T/rl/.venv/bin/rl"

cat > "$T/bin/uv" <<'UV'
#!/usr/bin/env bash
set -euo pipefail
vars="XDG_DATA_HOME XDG_STATE_HOME SESSION_TRACKER_PROJECTS_DIR CODEX_SESSIONS_DIR PI_SESSIONS_DIR FACTORY_HOME_OVERRIDE RINGLEADER_CLAUDE_SETTINGS"
case "$FAKE_UV_MODE" in
  fail)
    echo "export XDG_DATA_HOME=/tmp/live"
    exit 3
    ;;
  outside)
    for var in $vars; do echo "export $var=/elsewhere/$var"; done
    echo "export PATH='/elsewhere/bin':\"\$PATH\""
    ;;
  good|badpath|nomarker)
    root=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--root" ]; then root="$2"; shift; fi
      shift
    done
    mkdir -p "$root"
    if [ "$FAKE_UV_MODE" = nomarker ]; then rm -f "$root/.gui-world"; else : > "$root/.gui-world"; fi
    for var in $vars; do echo "export $var='$root/$var'"; done
    if [ "$FAKE_UV_MODE" = badpath ]; then
      echo "export PATH=\"\$PATH\""
    else
      echo "export PATH='$root/bin':\"\$PATH\""
    fi
    ;;
esac
UV
chmod +x "$T/bin/uv"

run_case() {
  local mode="$1" project="$2"
  (cd "$T/work" && PATH="$T/bin:$PATH" CIRCUS_RINGLEADER="$project" FAKE_UV_MODE="$mode" \
    bash -c 'set -euo pipefail; source "$1/scripts/sandbox-env.sh"; printf "%s\n" "$CIRCUS_ENV_LABEL" "$CIRCUS_WORLD_ROOT"' _ "$REPO")
}

expect_failure() {
  local name="$1" mode="$2" project="$3" out status=0
  out="$(run_case "$mode" "$project" 2>/dev/null)" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "FAIL $name: exited 0" >&2
    exit 1
  fi
  if printf '%s\n' "$out" | grep -qx sandbox; then
    echo "FAIL $name: printed the sandbox label" >&2
    exit 1
  fi
  echo "ok   $name"
}

expect_failure "uv failure exports nothing" fail "$T/rl"
expect_failure "exports outside the world are refused" outside "$T/rl"
expect_failure "missing gui_world.py is refused" good "$T/empty"
expect_failure "a PATH without the world bin first is refused" badpath "$T/rl"
expect_failure "a world without the .gui-world marker is refused" nomarker "$T/rl"
expect_failure "a non-executable venv rl is refused" good "$T/norl"

out="$(run_case good "$T/rl" 2>/dev/null)" || { echo "FAIL good world: exited non-zero" >&2; exit 1; }
expected="$(printf '%s\n%s' sandbox "$T/work/.local/sandbox/world")"
if [ "$out" != "$expected" ]; then
  echo "FAIL good world: got '$out'" >&2
  exit 1
fi
echo "ok   good world exports the sandbox label and world root"

out="$(cd "$T/work" && PATH="$T/bin:$PATH" CIRCUS_RINGLEADER="$T/it's" FAKE_UV_MODE=good \
  bash -c 'set -euo pipefail; source "$1/scripts/sandbox-env.sh"; python3 -c "import shlex,sys; print(shlex.split(sys.argv[1])[0])" "$CIRCUS_RL"' _ "$REPO" 2>/dev/null)" \
  || { echo "FAIL quoted path: exited non-zero" >&2; exit 1; }
if [ "$out" != "$T/it's/.venv/bin/rl" ]; then
  echo "FAIL quoted path: got '$out'" >&2
  exit 1
fi
echo "ok   CIRCUS_RL survives a quote in the project path"
