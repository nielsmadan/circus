# Architecture

## Process model

```text
React (src/)  ──typed Tauri commands──▶  Rust (src-tauri/)  ──spawn──▶  rl gui list|scan|tail|decide
   │                                          │                          (own session and process group)
   └── decodes raw bytes (JSON.parse)  ◀──────┘ returns stdout bytes unchanged
```

The frontend never runs a process and never reads ringleader's registry. Rust exposes ten `#[tauri::command]`s (`rl_list`, `rl_scan`, `rl_tails`, `rl_decide`, `cached_list`, `app_info`, `resume_session`, `set_pending`, `close_ack`, `app_exit`) with fixed argument shapes. There is no shell plugin and no generic exec. Each command is registered in `src-tauri/build.rs` and permitted in `src-tauri/capabilities/default.json`.

Responses from `rl gui` (list, scan, tails, outcome) and `cached_list` are passed through as raw bytes (`tauri::ipc::Response`, an `ArrayBuffer` in JS). Rust deserializes them only into a minimal `Envelope` (`kind`, `version`), so serde skips every other field, and rejects an unexpected kind or version. `src/api/client.ts` decodes with one module-level `TextDecoder` and `JSON.parse`; `src/api/types.ts` is the only typed consumer. `app_info` and `resume_session` return small Rust-built structs.

## The contract

`rl gui` prints exactly one JSON document per call, `"version": 1`, snake_case keys:

- `list` — every triage-relevant row with `in_recent` and `woke` flags, presence (`running` true, false or null when unknown), `lifecycle_block`, `mtime`, `file_fingerprint`, and the registry path.
- `scan` — a rescan summary (added, removed, unavailable sources).
- `tail` — one batched `tails` document for 1 to 16 ids; each item carries its own `mtime` and `file_fingerprint`, and an `unavailable` reason instead of failing the batch.
- `decide` — one `outcome` (`ok`, `refused`, `empty`, `failed`, with `wrote`) for one action on one session. Revalidation, presence refusal and locks are ringleader's.

Exit 0 means the requested document was printed (including refused outcomes); exit 1 carries an `error` document; an `rl` without the group exits 2 with `unknown command 'gui'`, which circus reports as "rl too old".

The source of truth is `docs/tech/gui-contract.md` in the ringleader checkout; this repo does not copy it. The golden documents ringleader generates live in `src/test/golden/` (copied by `just sync-golden`, compared by `just golden-check`) and are parsed by `src/api/golden.test.ts`. Rust fixtures in `src-tauri/tests/fixtures/` pin the envelope handling. To change the contract, change both sides together, then run `just sync-golden` and `just smoke-sandbox`.

## Finding and running `rl`

Resolution order: env `CIRCUS_RL` (shell-words; the sandbox points it at the worktree's `.venv/bin/rl`), then `rl_command` in `settings.json`, then one login-shell probe (`$SHELL -ilc`, sentinel markers, 5 s timeout, off the main thread, skipped when `CIRCUS_RL` is set), then the first executable `rl` in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`. Resolution starts at launch on a background thread and commands wait on it.

Every `rl` child gets PATH explicitly: the current PATH first, then login-shell entries not already present. Resume launchers get the same resolved PATH (`resume::WithPath`).

## Subprocesses and deadlines

Children start with `setsid`, so each is its own session leader and process group (this also keeps the interactive login-shell probe off the terminal's tty under `tauri dev`). On a deadline circus sends SIGTERM to the group, waits `KILL_GRACE` (5 s, longer than ringleader's own 2 s model-kill grace so `rl` can reap its model CLI first), sends SIGKILL to the group, always reaps, and never waits on pipe-drain threads past the grace. Deadlines are backstops: list 60 s, scan 300 s, tails 30 s, decide 120 s, harvest 420 s, resume launch 60 s.

## Outbox and undo

`src/inbox/outbox.ts` and `useInbox.ts`. The outbox lives above the tabs (all four panels stay mounted).

- Windows: delete waits 10 s (ringleader's delete grace); every other decision 4 s. `z` cancels the newest decision not yet sent. Undo appears only on that decision's toast; decision toasts are never evicted.
- Lanes: the fast lane is serial; the harvest lane runs two at a time. At most one entry per session id.
- Rows hide optimistically. `ok` and any `wrote: true` outcome keep the row hidden through the `applied` bridge until a `list()` that started after the settle lands. `refused` or `failed` with `wrote: false`, and `empty`, restore the row.
- A decide that times out or dies without a document is unknown: the row stays hidden, a toast says "result unknown — refreshing", and a list refetch follows.
- List refetch rules: one `list()` after every refused, failed, unknown or `wrote: true` outcome; a rescan (`scan()`) only for a refusal that says the session changed; `list()` and `scan()` on launch; `list()` on window focus when the last list is older than 60 s. Flights are single: a request during a flight queues one more.
- There is no automatic retry anywhere, and nothing is persisted: a crash or an uninterceptable quit drops unsent decisions, so nothing happens and the rows return on the next launch.
- In a sandbox, decisions are refused unless the list's registry lies under `CIRCUS_WORLD_ROOT`. Archive, delete and harvest are refused client-side for running or presence-unknown sessions, lifecycle-blocked sessions and sessions without a fingerprint.

## Close gate

`src-tauri/src/close.rs`, `lib.rs`, `src/inbox/FinishingOverlay.tsx`. The frontend reports pending plus in-flight work through `set_pending(n)` once its close listener is registered. With nothing pending, closing proceeds. Otherwise Rust prevents the close (red button, ⌘W, the custom ⌘Q item) and emits `circus://close-requested`. The frontend acks (`close_ack`), sends unsent decisions at once, shows "Finishing N changes…" with a "Discard unsent" button (in-flight ones always finish) and calls `app_exit` when idle; if `exit()` fails it toasts "Could not quit", reopens the outbox and lets the next close retry. Rust exits on its own if no ack arrives within 5 s or no `app_exit` within 450 s.

The Quit item is custom because the predefined one bypasses the gate. Dock › Quit and logout cannot be intercepted (tauri-apps/tauri#9198): unsent decisions are dropped, and `rl` processes already running finish headless.

## Shortcuts

`@shortcutkit/core` provides contexts and a registry (`src/shortcuts/contexts.ts`, in-memory store, no rebinding UI). Reading-pane buttons and the palette call `registry.dispatch`, so mouse and keys share one path. The DOM host and React bindings in `src/shortcuts/` are temporary.

| Context         | Action                                  | Default           |
| --------------- | --------------------------------------- | ----------------- |
| `app`           | Go to Enrich / Triage / Inbox / Harvest | ⌘1 / ⌘2 / ⌘3 / ⌘4 |
| `app`           | Command palette                         | ⌘K                |
| `inbox.list`    | Next / previous session                 | `j`, ↓ / `k`, ↑   |
| `inbox.list`    | Harvest, then archive                   | `e`               |
| `inbox.list`    | Archive without harvesting              | ⇧E                |
| `inbox.list`    | Delete                                  | ⇧3 (#)            |
| `inbox.list`    | Snooze…                                 | `h`               |
| `inbox.list`    | Keep long-term                          | `s`               |
| `inbox.list`    | Keep going (mark reviewed)              | `r`               |
| `inbox.list`    | Resume in terminal                      | `o`, Enter        |
| `inbox.list`    | Undo                                    | `z`               |
| `inbox.list`    | Search                                  | `/`               |
| `inbox.list`    | Back                                    | Esc               |
| `inbox.list`    | Next / previous split                   | Tab / ⇧Tab        |
| `inbox.list`    | Rescan sessions                         | none (palette)    |
| `snooze.dialog` | Close / Snooze                          | Esc / ⌘Enter      |
| `palette`       | Close palette                           | Esc, ⌘K           |

Decision keys do not repeat when held. Splits are Recent (last 7 days, newest first), Woke (oldest first) and All (oldest first); `src/inbox/derive.ts` is the only copy of the partition, order, count and project-grouping rules. Changing split resets the selection to the first row.

## Snooze

`src/snooze/parse.ts` is a pure `(text, now) → result` function, a superset of ringleader's `fuzzytime.py` grammar: relative amounts (`3d`, `in 2 hours`, `1w`), `today`/`tomorrow` with an optional time, weekdays (`fri`, `next fri 14:00`), `later today`, `next week`, `next month`, month-day dates, and bare times. A date without a time resolves to 09:00 local. The dialog also offers presets and a date-time picker; the last-focused input drives the preview and confirm, and the dialog unmounts on confirm. The result is sent as ISO 8601 and ringleader stores it in UTC.

## Resume

`resume_session` builds `rl resume <source:sessionId>` from the resolved `rl` command and runs it in iTerm2 through `osascript` (new window, `write text`), 60 s timeout so the first-run Automation prompt can be answered. `settings.json` `terminal_command` replaces the launcher. `src-tauri/Info.plist` carries `NSAppleEventsUsageDescription`. An osascript error `-1743` from the default launcher maps to a `launch` error naming System Settings › Privacy & Security › Automation; the same text from a custom launcher is not treated as a denial. `CIRCUS_RESUME_DRY_RUN=1` returns the command line instead of launching.

## Security

- CSP in `tauri.conf.json`: `default-src 'self'`, no remote scripts, `connect-src` limited to IPC and the dev server, `object-src 'none'`, `frame-ancestors 'none'`.
- Capability allowlist: only the ten app commands plus `core:default` for the `main` window.
- Fixed argument shapes: ids, times and fingerprints are length-limited and validated before spawning; tail ids are capped at 16.
- No shell plugin, no generic exec, no reading of `registry.json`.
- The sandbox decision guard refuses decisions when the registry is outside the world root.

## Performance

Budgets (enforced in `just check`):

| Budget                                                                                   | Test                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------- |
| Derive chain over 5 000 rows ≤ 8 ms; `indexRows` ≤ 25 ms                                 | `src/inbox/derive.perf.test.ts`     |
| `parseSnooze` ≤ 0.2 ms per call                                                          | `src/snooze/parse.perf.test.ts`     |
| One `j` keypress renders ≤ 3 rows with 5 000 rows                                        | `src/inbox/InboxView.perf.test.tsx` |
| `rl gui list\|scan\|tail` stay off the heavy imports; `list` over 2 000 threads ≤ 400 ms | ringleader `tests/test_gui_perf.py` |

Vitest budgets use real timers and the median of 21 runs after 5 warm-ups. QA targets (j/k keypress-to-paint under 16 ms at 2 000 rows, prefetched tail within one frame, cold first paint from the cache under 300 ms) are measured by hand; see `docs/development.md`.

How the budgets are met:

- Raw-bytes IPC with envelope-only validation (above): no `serde_json::Value` tree in Rust.
- List cache: after every successful `rl gui list`, Rust writes stdout atomically (temp file, then rename) to `<app_data_dir>/list-cache.json`. `cached_list` returns those bytes, or an empty body when there is no valid cache, without waiting for `rl` resolution. On launch the UI paints from it with a "Cached · refreshing…" chip, then revalidates. With `CIRCUS_ENV_LABEL` set the cache is `<CIRCUS_WORLD_ROOT>/.circus/list-cache.json`, and it is disabled when the label has no world root, so a sandbox never writes outside its world.
- Batched tail prefetch: the selected row plus neighbours −2..+5 of the visible order in one `tails` call, single flight, latest wins, into a 64-entry LRU keyed `(id, mtime, file_fingerprint)`. Prefetch is scheduled after the selection paints (`requestAnimationFrame`, then `setTimeout(0)`, coalesced while keys are held). When a landed tail no longer matches its row, the pane shows it labelled "May be out of date…" until the fresh one lands.
- Selection hot path: one synchronous state update per keypress with no awaits, timers or layout reads; scrollTop and viewport height live in refs fed by the scroll handler and a `ResizeObserver`. Rows are `React.memo` components keyed by id with props `row`, `selected` and one stable `onSelect`, in a fixed-height window. The derive chain is memoized on list, outbox entries, applied, split, project and query, never on the selection, and uses a per-list `RowIndex` (parsed mtime and lowercase haystack, built once per adopted list). Tails render as plain text in `<pre>` chunks with `content-visibility: auto`.
- Ringleader side: `rl gui` has a fast dispatch (`argv[0] == "gui"` routes to `gui_cli` without importing the command table), `list`/`scan`/`tail` import neither `textual`, `ringleader.commands`, `models`, `enrichment` nor `decisions`, and `decide` loads its stack on demand.
