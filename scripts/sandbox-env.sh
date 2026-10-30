# Sourced from the repo root by recipes running `set -euo pipefail`; builds the synthetic world.
RL_PROJECT="${CIRCUS_RINGLEADER:-$PWD/../../ringleader/dev2}"
[ -f "$RL_PROJECT/scripts/gui_world.py" ] || { echo "sandbox: $RL_PROJECT/scripts/gui_world.py not found (set CIRCUS_RINGLEADER)" >&2; exit 1; }
mkdir -p "$PWD/.local/sandbox"
WORLD="$(cd "$PWD/.local/sandbox" && pwd -P)/world"
unset OPENCODE_DB RINGLEADER_VENDOR_DIR
exports="$(uv run --project "$RL_PROJECT" python "$RL_PROJECT/scripts/gui_world.py" --root "$WORLD" --exports)" \
  || { echo "sandbox: gui_world.py failed; nothing exported" >&2; exit 1; }
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
[ -x "$RL_PROJECT/.venv/bin/rl" ] || { echo "sandbox: $RL_PROJECT/.venv/bin/rl is not executable (run uv sync there)" >&2; exit 1; }
CIRCUS_RL="$(printf '%q' "$RL_PROJECT/.venv/bin/rl")"
export CIRCUS_RL
export CIRCUS_ENV_LABEL=sandbox
export CIRCUS_WORLD_ROOT="$WORLD"
export CIRCUS_RESUME_DRY_RUN=1
