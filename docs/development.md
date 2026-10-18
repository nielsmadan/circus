# Development

## Setup

`just setup` installs dependencies (`pnpm install --frozen-lockfile`), the lefthook git hooks, and runs `just doctor`. The doctor checks Node 24, pnpm, cargo, rustup components, lefthook, just, the sibling `../shortcutkit-js/packages/core/src/index.ts`, git hooks, the ringleader worktree (warning only) and the golden documents (warning only), and prints a content hash of the linked `@shortcutkit/core` source because that checkout has no pinned version.

`just check` is the gate: prettier, eslint, tsc, vitest, vite build, `cargo fmt --check`, clippy `-D warnings`, cargo test, and the `sandbox-env.sh` test. CI runs the same recipe.

## The sandbox world

`just dev-sandbox` and `just smoke-sandbox` source `scripts/sandbox-env.sh`, which builds a synthetic world under `.local/sandbox/world` with ringleader's `scripts/gui_world.py` (`uv run --project ../circus-worktrees/ringleader`; override with `CIRCUS_RINGLEADER`) and exports its environment. The script aborts unless every world variable (`XDG_DATA_HOME`, `XDG_STATE_HOME`, `SESSION_TRACKER_PROJECTS_DIR`, `CODEX_SESSIONS_DIR`, `PI_SESSIONS_DIR`, `FACTORY_HOME_OVERRIDE`, `RINGLEADER_CLAUDE_SETTINGS`) lies under the world root and `PATH` starts with the world's `bin/`.

The world holds:

- a registry of synthetic sessions across several projects, including one running session (fake presence), so refusals for running sessions can be seen;
- a fake harvest model: sessions under `proj-00` harvest as empty, every other project harvests after a short delay (`GUI_WORLD_HARVEST_DELAY`, default 3 s);
- a `claude` stub that exits 97, so the real one can never run;
- dry-run resume (`CIRCUS_RESUME_DRY_RUN=1`): the resume toast shows the command instead of opening iTerm2.

The world is rebuilt on every launch, so a sandbox launch starts without a list cache. The sandbox also sets `CIRCUS_RL` to the worktree's `.venv/bin/rl` (run `uv sync` there once), `CIRCUS_ENV_LABEL=sandbox` (SANDBOX badge, decision guard) and `CIRCUS_WORLD_ROOT`.

`just smoke-sandbox` runs `golden-check`, then the ignored Rust test `contract_smoke` against real `rl gui` in the world. Never run `rl` or `python -m ringleader` outside these recipes.

## The fake harness

`pnpm dev:fake` serves the whole Inbox in a plain browser over the in-memory API in `src/dev/memoryApi.ts`: list, reading pane, all six decisions with undo, snooze dialog, dry-run resume toast, ⌘K palette. No Tauri, no `rl`. It is what agent-browser drives.

The fake decides as `rl gui decide` does, so QA in the harness sees real outcomes: archive, delete and harvest are refused without a five-field numeric fingerprint (the synthetic rows carry real-shaped ones), then for a lifecycle block (`cannot <action> …`), a session that left the registry or a changed `mtime`, then for a running or presence-unknown session, in that order; keep and keep going on a missing session are `failed`; a snooze without `until` is rejected as `invalid_argument` the way Rust rejects it, and an unparsable, offset-less or past `until` is refused.

- `VITE_FAKE_ROWS` — synthetic row count (default 2000)
- `VITE_FAKE_LATENCY_MS` — simulated latency per call (default 150)
- `VITE_FAKE_CACHE=0` — start without a cached list (default: a cache is available, so the first paint comes from it)
- `window.circusFake.requestClose()` — simulate a window close request (with 450 s left) to see the "Finishing N changes…" overlay with a pending decision

Example: `VITE_FAKE_ROWS=5000 VITE_FAKE_LATENCY_MS=0 pnpm dev:fake`.

QA each Inbox behavior in the harness:

- keys `j`/`k`/arrows, `/` search, Tab and ⇧Tab splits, project sidebar, `Esc` back;
- `e`, ⇧E, `#`, `h` (dialog: typed text, picker, presets, ⌘Enter), `s`, `r`, each followed by `z` within the window, and again after the window to see the row stay hidden;
- `o` / Enter: dry-run toast;
- ⌘K palette and its commands; ⌘1–⌘4 tabs;
- `window.circusFake.requestClose()` with one pending decision: overlay, "Discard unsent".

## Performance

Targets:

- `j`/`k` keypress-to-paint under 16 ms at 2 000 rows
- a prefetched tail shown within one frame of its selection
- cold first paint from the list cache under 300 ms after the window is shown

Measure in the fake harness (dev-only marks from `src/inbox/perfMarks.ts`, absent from the production bundle):

1. Run `pnpm dev:fake` and open it with agent-browser.
2. Hold or repeat `j`.
3. Read `performance.getEntriesByType('measure')` through agent-browser's JS evaluation and take the median of the `select-to-paint:*` and `select-to-pane:*` durations. For a prefetched tail the pane measure should land in the same frame as the paint measure.
4. Cold first paint: reload with the cache on (`VITE_FAKE_CACHE` unset) and read the first row's appearance time relative to `performance.timeOrigin`. In `Circus.app`, relaunch after one successful list and check the list is visible immediately with the "Cached · refreshing…" chip.

Budget tests: `pnpm test` runs every `*.perf.test.ts*` (derive chain, `indexRows`, `parseSnooze`, one `j` keypress re-render count). Ringleader's budgets are in its `tests/test_gui_perf.py` (`uv run python -m pytest tests/test_gui_perf.py` there). The thresholds are requirements; fix the code rather than the number.

Next lever: if cold `rl` spawns (about 100–300 ms per call) still feel slow, the next step is a persistent `rl gui serve` sidecar speaking the same documents over stdin/stdout. It is deliberately not built.

## Changing the contract

1. Change ringleader's `docs/tech/gui-contract.md`, implementation and golden documents (`tests/golden/gui-*.json`) there.
2. Run `just sync-golden` here; update `src/api/types.ts`, the Rust `Envelope` and fixtures if the version or shapes changed.
3. Run `just check` and `just smoke-sandbox`. `just golden-check` fails when the copies drift.

## User-run native QA

These need the native window and are run by hand; agents do not run them. Use the SANDBOX app for decisions and quitting; use `Circus.app` only for the last items.

1. `just dev-sandbox` opens a window titled Circus with the SANDBOX badge and the session list.
2. `e`, ⇧E, `#`, `h`, `s`, `r` each hide the row with a toast, and `z` brings it back inside the window.
3. ⌘K opens the palette; Esc closes it.
4. `o` shows the dry-run toast with the `rl resume …` command line.
5. With a pending decision, ⌘Q and the red button show "Finishing…" and quit after it completes.
6. With a pending decision, Dock › Quit quits at once; the row is back on the next launch.
7. `just build-debug` produces `src-tauri/target/debug/bundle/macos/Circus.app` (unsigned).
8. One real resume from `Circus.app`, without `CIRCUS_RESUME_DRY_RUN`, against an `rl` installed from the ringleader branch (`just install` there; set `rl_command` in settings if it is not on the login shell's PATH): iTerm2 opens and macOS prompts for Automation. Denying it shows the hint naming System Settings › Privacy & Security › Automation.
9. Relaunch `Circus.app` after a successful list: the list paints immediately with the "Cached · refreshing…" chip, which disappears when the live list lands.
10. Hold `j` over a long list: it scrolls smoothly and the reading pane follows.
