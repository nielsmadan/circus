# Circus

A macOS desktop app for [ringleader](../ringleader). Circus shows the dormant agent sessions ringleader tracks as an inbox: a session list, a reading pane with the end of the transcript, and one-key decisions (harvest and archive, archive, delete, snooze, keep long-term, keep going) with undo. Enrich, Triage and Harvest tabs exist as placeholders. Everything the app knows about sessions comes from `rl gui`, ringleader's versioned JSON interface.

Tauri 2, React 19, TypeScript, Rust. Unsigned, no updater; macOS only.

## Requirements

- macOS 12 or later
- Node 24 and pnpm 12.9.0 (`packageManager` in `package.json`)
- Rust stable with `clippy` and `rustfmt`, `just`, `lefthook`
- a checkout of `shortcutkit-js` beside this one (`../shortcutkit-js`); `@shortcutkit/core` is linked from it
- for the sandbox recipes: the ringleader worktree at `../circus-worktrees/ringleader` (override with `CIRCUS_RINGLEADER`) with `uv sync` run in it
- for real use: an `rl` installed from the ringleader branch that has the `rl gui` group (`just install` in that checkout)

## Quick start

```sh
just setup          # dependencies, git hooks, doctor
just dev-sandbox    # native window against a synthetic world; never touches live data
pnpm dev:fake       # plain browser, in-memory fake API, no rl
just build-debug    # src-tauri/target/debug/bundle/macos/Circus.app
```

`just check` runs everything CI runs. `just doctor` reports missing tools. There is deliberately no `just dev` against live data.

## Configuration

`Circus.app` reads `settings.json` from its app config directory (the path appears in the error when `rl` cannot be found):

```json
{
  "rl_command": ["/Users/me/.local/bin/rl"],
  "terminal_command": ["wezterm", "start", "--", "sh", "-c", "{command}"]
}
```

- `rl_command` — argv array used instead of searching for `rl`.
- `terminal_command` — argv array that replaces the iTerm2 launcher for resume; `{command}` inside any element is replaced by the `rl resume …` command line.

Environment variables: `CIRCUS_RL` (command line, wins over settings), `CIRCUS_ENV_LABEL` (shows a badge and enables the sandbox decision guard), `CIRCUS_WORLD_ROOT`, `CIRCUS_RESUME_DRY_RUN=1`. The recipes set the sandbox ones for you.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — process model, contract, outbox, close gate, shortcuts, security, performance.
- [`docs/development.md`](docs/development.md) — sandbox world, fake harness, performance procedure, native QA checklist.
- [`AGENTS.md`](AGENTS.md) — rules for coding agents working in this repo.
