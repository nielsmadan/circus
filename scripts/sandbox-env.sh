# Sourced from the repo root by recipes running `set -euo pipefail`; builds the synthetic world.
RL_DIR="${CIRCUS_RINGLEADER_DIR:-}"
[ -n "$RL_DIR" ] || RL_DIR="$(scripts/fetch-ringleader.sh)" || { echo "sandbox: could not stage the pinned ringleader release" >&2; exit 1; }
[ -x "$RL_DIR/venv/bin/python" ] || { echo "sandbox: $RL_DIR/venv/bin/python is not executable (set CIRCUS_RINGLEADER_DIR to a staged release)" >&2; exit 1; }
mkdir -p "$PWD/.local/sandbox"
WORLD="$(cd "$PWD/.local/sandbox" && pwd -P)/world"
unset OPENCODE_DB RINGLEADER_VENDOR_DIR
exports="$("$RL_DIR/venv/bin/python" -m ringleader.devtools.gui_world --root "$WORLD" --exports)" \
  || { echo "sandbox: the world generator failed; nothing exported" >&2; exit 1; }
eval "$exports"
for var in XDG_DATA_HOME XDG_STATE_HOME SESSION_TRACKER_PROJECTS_DIR CODEX_SESSIONS_DIR PI_SESSIONS_DIR FACTORY_HOME_OVERRIDE RINGLEADER_CLAUDE_SETTINGS; do
  value="${!var:-}"
  case "$value" in
    "$WORLD"/*) ;;
    *) echo "sandbox: $var is not inside $WORLD (got '${value}')" >&2; exit 1 ;;
  esac
done
case "$PATH" in
  "$WORLD/bin:"*) ;;
  *) echo "sandbox: PATH does not start with $WORLD/bin" >&2; exit 1 ;;
esac
[ -e "$WORLD/.gui-world" ] || { echo "sandbox: $WORLD/.gui-world is missing" >&2; exit 1; }
[ -x "$RL_DIR/venv/bin/rl" ] || { echo "sandbox: $RL_DIR/venv/bin/rl is not executable" >&2; exit 1; }
CIRCUS_RL="$(printf '%q' "$RL_DIR/venv/bin/rl")"
export CIRCUS_RL
export CIRCUS_ENV_LABEL=sandbox
export CIRCUS_WORLD_ROOT="$WORLD"
export CIRCUS_RESUME_DRY_RUN=1
