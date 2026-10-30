# Circus

Circus is a Tauri 2 macOS desktop app for [ringleader](../../ringleader/dev2) (`rl`). It has four tabs (Enrich, Triage, Inbox, Harvest); only the Inbox is implemented: a Superhuman-style list and reading pane over dormant agent sessions, with one-key decisions, undo, a snooze dialog, a command palette and resume in iTerm2.

The app talks to ringleader only by spawning `rl inbox --json [--scan]`, `rl data export … --json` and the guarded `rl session archive|delete|harvest|snooze|keep|mark reviewed … --json --if-mtime=…`. The contract is `docs/tech/json-contract.md` in the ringleader checkout (`../../ringleader/dev2`); that file is the source of truth. Read `docs/architecture.md` before changing the Rust/TS boundary, the outbox or the close gate, and `docs/development.md` for dev, QA and the performance procedure.

## Layout

- `src/` — React 19 + TypeScript frontend. `api/` (typed Tauri client, the only typed consumer of `rl` responses), `inbox/` (controller, outbox, derive, views), `snooze/`, `palette/`, `shortcuts/`, `dev/` (in-memory fake API for `pnpm dev:fake`, which mirrors the guarded `rl session` refusals and their order), `test/` (fixtures and golden copies).
- `src-tauri/` — Rust: `rl.rs` (typed requests, raw-bytes responses), `process.rs` (process groups, deadlines), `config.rs` (`rl` resolution, settings), `resume.rs`, `close.rs` (close gate), `cache.rs` (list cache), `commands.rs`, `lib.rs` (menu, window events).
- `scripts/` — `sandbox-env.sh` (builds the synthetic world and exports its environment) and its test.
- `Justfile` — every command below.

## Commands

- `just setup` — install dependencies and git hooks, then verify. `just doctor` — verify tools and checkout state.
- `just check` — everything CI runs: prettier, eslint, tsc, vitest (the `*.perf.test.ts*` budgets run in a second, serial pass), vite build, cargo fmt/clippy/test, the `sandbox-env.sh` test.
- `just test`, `just lint`, `just format`, `just typecheck`, `just build`.
- `just dev-sandbox` — the native app against a freshly built synthetic world. `just smoke-sandbox` — the Rust client against real `rl` in that world.
- `pnpm dev:fake` — Vite only, in-memory fake API, no Tauri and no `rl`. Agents drive this with agent-browser.
- `just build-debug` — unsigned `src-tauri/target/debug/bundle/macos/Circus.app`.
- `just sync-golden` / `just golden-check` — copy / compare ringleader's `tests/golden/contract-*.json` into `src/test/golden/`.

## Gotchas

- Live data is never touched in development. There is no `just dev`. Only `dev-sandbox` and `smoke-sandbox` run `rl`, and only inside the world built by ringleader's `scripts/gui_world.py`; `pnpm dev:fake` never spawns `rl`. `scripts/sandbox-env.sh` aborts unless every world variable lies under the world root. Never run the installed `rl` or `python -m ringleader` outside those recipes.
- In the sandbox the app refuses every decision unless the list's `registry` lies under `CIRCUS_WORLD_ROOT` (`decisionGuard` in `src/inbox/derive.ts`).
- Changing the contract: edit ringleader's `docs/tech/json-contract.md` and goldens and circus together, then `just sync-golden`. `just smoke-sandbox` and `golden-check` fail on drift.
- `rl` resolution order: `CIRCUS_RL` (shell-words), `rl_command` in `settings.json`, one login-shell probe, then `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`. With `CIRCUS_ENV_LABEL` set, an unset, empty or unsplittable `CIRCUS_RL` resolves to no `rl` at all, never to an installed one. Other variables: `CIRCUS_ENV_LABEL` (SANDBOX badge, guard on), `CIRCUS_WORLD_ROOT`, `CIRCUS_RESUME_DRY_RUN=1` (resume returns the command instead of launching). `settings.json` (in the app config dir) keys: `rl_command` and `terminal_command`, both argv arrays; `{command}` inside any `terminal_command` element is replaced by the `rl resume …` command line.
- `rl` JSON responses travel as raw bytes: Rust checks only `kind` and `version` through a minimal `Envelope` struct and returns stdout unchanged. Never add a `serde_json::Value` round-trip. `src/api/client.ts` decodes with one module-level `TextDecoder`.
- A new Tauri command needs three edits: the `#[tauri::command]`, its name in `src-tauri/build.rs`, and `allow-<name>` in `src-tauri/capabilities/default.json`. There is no shell plugin and no generic exec. Core permissions are listed one by one (today only `core:event:allow-listen` and `allow-unlisten`); never add `core:default` or any `core:menu:*`, which let page script install a menu whose Quit bypasses the close gate.
- Children of `rl` spawn with `setsid` (own session and process group). On a deadline circus sends SIGTERM to the group, waits `KILL_GRACE` (5 s, longer than ringleader's own 2 s model-kill grace), then SIGKILL. The login-shell probe is SIGKILLed at its 5 s deadline instead, because interactive shells ignore SIGTERM.
- Resume launchers inherit the resolved login PATH (`resume::WithPath`), so a custom `terminal_command` like `["wezterm", "start", "--", "sh", "-c", "{command}"]` resolves from a Finder-launched app. `{command}` is one shell command line, so a terminal that runs argv needs the `sh -c` wrapper. A custom launcher still running after 5 s (a terminal that stays in the foreground) counts as launched and is left running; it is never killed.
- The Quit menu item is custom because the predefined one bypasses the close gate. Dock › Quit and logout cannot be intercepted; unsent decisions are dropped then.
- `@shortcutkit/core` is a `link:` to the sibling `../shortcutkit-js/packages/core`, and is consumed from its built `dist/`, which must be built in the sibling (`pnpm install && pnpm --filter @shortcutkit/core build`; `just doctor` does not check it); `vite.config.ts` allows serving the sibling. The app-local `src/shortcuts/keyboard-host.ts` and `src/shortcuts/react.tsx` are temporary; they go away when `@shortcutkit/dom` and `@shortcutkit/react` replace them. Do not add matching, rebinding, legend or persistence code here.
- Recipes that compile (`lint`, `test`, `dev-sandbox`, `smoke-sandbox`, `build-debug`) depend on `ensure-dist`, because `generate_context!` needs `dist/`.
- Inbox behaviour that is deliberate: Undo shows only on the newest unsent decision's toast; decision toasts are not evicted by the 5-toast cap; a failed `exit()` cancels the Rust close gate (`close_cancel`) and reopens the outbox; the Finishing overlay states when Rust will quit regardless and how many unsent changes that would drop; changing split resets selection to the first row; windowed rows carry no `aria-setsize`/`aria-posinset` (an index prop would break the re-render budget); the reading pane shows an older tail labelled "May be out of date…" while a fresh one loads; the snooze dialog's last-focused input wins and the dialog unmounts on confirm.
- The `*.perf.test.ts*` budget tests are requirements. Never loosen, skip or retry them to get green. The key path (`j`/`k` to paint) stays free of `await`, timers, `startTransition`, `useDeferredValue` and layout reads.
- Exact-pin every npm dependency and Rust crate (no `^`, no `~`).

## Conventions

- Commits: `feat:`, `fix:` or `chore:`, no scope, one short clause, no body. Message names only this repo's change.
- Comments: none by default; one terse line for a non-obvious invariant or workaround. No JSDoc.
- Functional style: pure functions at module boundaries, effects at the edges, no mutation of arguments.
- Tests assert what the code does, not what it does not do.
- `pnpm` 12.9.0 (`packageManager`), Node 24, TypeScript strict, prettier (`singleQuote`, `trailingComma: all`, `printWidth: 100`), Rust edition 2024 with clippy `-D warnings`.
