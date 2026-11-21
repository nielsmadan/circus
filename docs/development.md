# Development

## Setup

`just setup` installs dependencies (`pnpm install --frozen-lockfile`), the lefthook git hooks, and runs `just doctor`. The doctor checks Node 24, pnpm, cargo, rustup components, lefthook, just, the installed core, DOM and React source entries in `node_modules/@shortcutkit`, git hooks, `jq` and `gh` (warnings), the pinned ringleader version and the golden documents (warning only).

`just check` is the gate: prettier, eslint, tsc, vitest, vite build, `cargo fmt --check`, clippy `-D warnings`, cargo test, and the `sandbox-env.sh` test. CI runs the same recipe.

ShortcutKit is installed directly from GitHub using Git subdirectory dependencies in `package.json`, all pinned to the same full commit. `pnpm-lock.yaml` records the revision and archive integrity for local and CI installs. The pinned revision ships TypeScript sources without built `dist/` files, so `vite.config.ts` aliases and `tsconfig.json` paths target each installed `src/index.ts`. TypeScript also includes core’s ambient timer declarations from `src/globals.d.ts`. Vite compiles the packages as part of Circus and deduplicates the shared runtimes. Both doctor commands verify the source entries. To upgrade, change all three Git pins together, regenerate the lockfile with `pnpm install`, and run `just check`.

## The sandbox world

`just sandbox` and `just test-smoke` source `scripts/sandbox-env.sh`, which builds a synthetic world under `.local/sandbox/world` with the pinned release's `python -m ringleader.devtools.gui_world` and exports its environment. `scripts/fetch-ringleader.sh` stages the release once into `.cache/ringleader/<version>/` (wheel checked against the sha256 in `ringleader.json` and every asset against `SHA256SUMS`, plus a venv with the wheel installed); `CIRCUS_RINGLEADER_DIR` replaces it with another staged directory, such as `just stage-ringleader`'s. The script aborts unless every world variable (`XDG_DATA_HOME`, `XDG_STATE_HOME`, `SESSION_TRACKER_PROJECTS_DIR`, `CODEX_SESSIONS_DIR`, `PI_SESSIONS_DIR`, `FACTORY_HOME_OVERRIDE`, `RINGLEADER_CLAUDE_SETTINGS`) lies under the world root and `PATH` starts with the world's `bin/`.

The world holds:

- a registry of synthetic sessions across several projects, including one running session (fake presence), so refusals for running sessions can be seen;
- a fake harvest model: sessions under `proj-00` harvest as empty, every other project harvests after a short delay (`GUI_WORLD_HARVEST_DELAY`, default 3 s);
- a `claude` stub that exits 97, so the real one can never run;
- dry-run resume (`CIRCUS_RESUME_DRY_RUN=1`): resume and `t` show a "Dry run — would open …" toast, with the command line as the toast's detail, instead of opening iTerm2.

The world is rebuilt on every launch, so a sandbox launch starts without a list cache. The sandbox also sets `CIRCUS_RL` to the staged venv's `rl`, `CIRCUS_ENV_LABEL=sandbox` (SANDBOX badge, decision guard) and `CIRCUS_WORLD_ROOT`.

`just test-smoke` runs `golden-check`, then the ignored Rust test `contract_smoke` against real `rl` in the world. Never run `rl` or `python -m ringleader` outside these recipes.

## The fake harness

`pnpm dev:fake` serves the whole Inbox in a plain browser over the in-memory API in `src/dev/memoryApi.ts`: list, reading pane, the Today, Snoozed and Kept splits, all eight decisions with undo, multi-selection and bulk decisions, snooze dialog, next steps, the `t` hand-off, dry-run resume toast, ⌘K palette, and the setup screen. No Tauri, no `rl`. It is what agent-browser drives.

The fake decides as the guarded `rl session` verbs do, so QA in the harness sees real outcomes: archive, delete and harvest are refused without a five-field numeric fingerprint (the synthetic rows carry real-shaped ones), then for a lifecycle block (`cannot <action> …`), a session that left the registry or a changed `mtime`, then for a running or presence-unknown session, in that order; keep, keep going, unkeep and wake on a missing session are `failed`; keep moves a session into `kept` and unkeep moves it back, clearing its snooze and reviewed mark, while unkeep of a session that is not kept is `ok` with `wrote: false`; snooze moves a session into `snoozed` and wake moves it back, clearing the snooze and the reviewed mark (`ok`, `wrote: false` when it is not snoozed), and a snooze whose time has passed is listed as a woke inbox row; every 50th synthetic session starts kept and every 100th starts snoozed, a fifth of those with no wake date; a snooze without `until` is rejected as `invalid_argument` the way Rust rejects it, and an unparsable, offset-less or past `until` is refused.

Home is `/u`, and the synthetic projects use five folder layouts so every sidebar view has something to show: repos cloned twice (`/u/wrksp/proj-NN/dev1`, `dev2`), packages of one monorepo (`/u/wrksp/mono/packages/proj-NN`), plain local repos (`/u/work/proj-NN`), folders outside git (`/u/notes/proj-NN`) and repos outside home (`/opt/src/proj-NN`); about one session in a hundred has no folder.

- `VITE_FAKE_ROWS` — synthetic row count (default 2000)
- `VITE_FAKE_LATENCY_MS` — simulated latency per call (default 150)
- `VITE_FAKE_CACHE=0` — start without a cached list (default: a cache is available, so the first paint comes from it)
- `VITE_FAKE_SETUP=missing|too_old|outdated|current` — start on the setup screen with that install state (default: onboarded and current)
- `window.circusFake.requestClose()` — simulate a window close request (with 450 s left) to see the "Finishing N changes…" overlay with a pending decision

Example: `VITE_FAKE_ROWS=5000 VITE_FAKE_LATENCY_MS=0 pnpm dev:fake`.

QA each Inbox behavior in the harness:

- keys `j`/`k`/arrows, `/` search, Tab and ⇧Tab splits, `Esc` back;
- the sidebar's Repos, Folders, Tree and Dates tabs (selection per tab, an emptied selection offering the next entry), dragging, arrow-stepping and double-clicking its divider;
- `e`, ⇧E, `#`, `h` (dialog: typed text, picker, presets, ⌘Enter), `s`, `r`, each followed by `z` within the window, and again after the window to see the row stay hidden;
- the Today and Snoozed splits: Today lists the rows active today and moves on with the next day's list; a row snoozed with `h` appears in Snoozed with its wake time; `w` (and the reading pane's Wake now) sends it back to the inbox, `z` undoes, `h` re-snoozes; `w` on an inbox row and `s`/`r` on a snoozed row are refused with a toast;
- the Kept split: a row kept with `s` appears there newest first; `u` (and the reading pane's Return to inbox) sends it back to Recent/All, `z` undoes; `u` on an inbox row and `h`/`s`/`r` on a kept row are refused with a toast;
- `o` / Enter: dry-run toast;
- selection: click, ⌘-click (and ⌘-click deselecting the last row), ⇧-click, ⇧J/⇧K and ⇧↓/⇧↑, Home/End and ⇧Home/⇧End, ⌘A in the list and in the search box or palette, Esc clearing the selection first, double-click resuming; `x` selects, ⇧8 selects all; a decision on several rows: confirm dialog for archive/delete, one batch toast, `z` undoes the unsent members;
- `t`: agent picker with several agents, dry-run hand-off toast; next-steps strip buttons;
- ⌘K palette and its commands; ⌘1–⌘3 tabs;
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

Budget tests: `pnpm test` runs every `*.perf.test.ts*` (derive chain, `indexRows`, `parseSnooze`, one `j` keypress re-render count) in a second vitest pass with `--no-file-parallelism`, after the rest of the suite, so sibling test workers do not compete for the CPU they measure. Ringleader's budgets are in its `tests/test_contract_perf.py` (`uv run python -m pytest tests/test_contract_perf.py` there). The thresholds are requirements; fix the code rather than the number.

Next lever: if cold `rl` spawns (about 100–300 ms per call) still feel slow, the next step is a persistent sidecar speaking the same documents over stdin/stdout. It is deliberately not built.

## Changing the contract

1. Change ringleader's `docs/tech/json-contract.md`, implementation and golden documents (`tests/golden/contract-*.json`) there.
2. `just stage-ringleader <checkout>`, then run the recipes below with `CIRCUS_RINGLEADER_DIR=$PWD/.cache/ringleader/checkout`.
3. Run `just sync-golden` here; update `src/api/types.ts`, the Rust `Envelope` and fixtures if the version or shapes changed.
4. Run `just check` and `just test-smoke`. `just golden-check` fails when the copies drift.
5. Once ringleader tags the release, `just pin-ringleader <version>` (raise `minimum` in `ringleader.json` if circus now depends on the change) and rerun `just golden-check` without the override.

Next lever: if updating `src/api/types.ts` by hand starts to cost real time (a larger contract, or a third consumer), ringleader would ship a JSON Schema per document beside `contract-golden.tar.gz`, circus would generate its types from it, and both sides would validate their goldens against it. The goldens stay either way, since they also catch value drift a schema allows. It is deliberately not built.

## User-run native QA

These need the native window and are run by hand; agents do not run them. Use the SANDBOX app for decisions and quitting; use `Circus.app` only for the last items.

1. `just sandbox` opens a window titled Circus with the SANDBOX badge and the session list.
2. `e`, ⇧E, `#`, `h`, `s`, `r` each hide the row with a toast, and `z` brings it back inside the window.
3. ⌘K opens the palette; Esc closes it.
4. `o` shows the "Dry run — would open …" toast; its detail is the `rl resume …` command line.
5. With a pending decision, ⌘Q and the red button show "Finishing…" and quit after it completes.
6. With a pending decision, Dock › Quit quits at once; the row is back on the next launch.
7. `just build-debug` produces `src-tauri/target/debug/bundle/macos/Circus.app` (unsigned).
8. One real resume from `Circus.app`, without `CIRCUS_RESUME_DRY_RUN`, against the `rl` onboarding installed: iTerm2 opens and macOS prompts for Automation. Denying it shows the hint naming System Settings › Privacy & Security › Automation.
9. Relaunch `Circus.app` after a successful list: the list paints immediately with the "Cached · refreshing…" chip, which disappears when the live list lands.
10. Hold `j` over a long list: it scrolls smoothly and the reading pane follows.
11. ⌘A in the SANDBOX app's session list selects every row; with the search box focused it selects the search text.
12. View › Appearance: Light and Dark switch the title bar, the menus and the whole UI at once, and exactly one item stays checked, including after clicking the checked one. With Follow System, toggling System Settings › Appearance switches the app live. The choice survives a relaunch, and a choice made in the SANDBOX app does not change `Circus.app`.
13. Onboarding in `Circus.app` with a fresh `setup.json`: the setup screen says which ringleader it will use; Install (or Update) installs the pinned release; Start runs the presence step and, if ticked, skills and hooks, then opens the Inbox. If the presence step fails, the Inbox opens with a warning toast and the presence banner offers the retry.
