# Circus

A macOS desktop app for [ringleader](../../ringleader/dev2). Circus shows the dormant agent sessions ringleader tracks as an inbox: a session list, a reading pane with the end of the transcript, and one-key decisions (harvest and archive, archive, delete, snooze, keep long-term, keep going) with undo. Enrich, Triage and Harvest tabs exist as placeholders. Everything the app knows about sessions comes from ringleader's versioned JSON mode (`--json` on `rl inbox`, `rl data export` and the guarded `rl session` verbs).

Tauri 2, React 19, TypeScript, Rust. Unsigned, no updater; macOS only.

## Requirements

- macOS 12 or later
- Node 24 and pnpm 12.9.0 (`packageManager` in `package.json`)
- Rust stable with `clippy` and `rustfmt`, `just`, `lefthook`
- a checkout of `shortcutkit-js` beside this one (`../shortcutkit-js`); `@shortcutkit/core` is linked from it
- for the sandbox recipes: the ringleader checkout at `../../ringleader/dev2` (override with `CIRCUS_RINGLEADER`) with `uv sync` run in it
- for real use: an `rl` installed from a ringleader checkout that has the `--json` commands (`just install` in that checkout)

## Quick start

```sh
just setup          # dependencies, git hooks, doctor
just run            # native window against your live sessions, through the installed rl
just sandbox        # native window against a synthetic world; never touches live data
pnpm dev:fake       # plain browser, in-memory fake API, no rl
just build-debug    # src-tauri/target/debug/bundle/macos/Circus.app
```

`just check` runs everything CI runs. `just doctor` reports missing tools. `just run` needs an `rl` with the `--json` commands on your login shell's PATH (`just install` in the ringleader checkout).

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

View › Appearance switches between Follow System (the default), Light and Dark. The choice is saved to `preferences.json` in the same directory and applied at the next launch; the app writes that file itself.

Environment variables: `CIRCUS_RL` (command line, wins over settings), `CIRCUS_ENV_LABEL` (shows a badge and enables the sandbox decision guard), `CIRCUS_WORLD_ROOT`, `CIRCUS_RESUME_DRY_RUN=1`. The recipes set the sandbox ones for you.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — process model, contract, outbox, close gate, shortcuts, security, performance.
- [`docs/development.md`](docs/development.md) — sandbox world, fake harness, performance procedure, native QA checklist.
- [`AGENTS.md`](AGENTS.md) — rules for coding agents working in this repo.
