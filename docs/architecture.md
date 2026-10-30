# Architecture

## Process model

```text
React (src/)  ──typed Tauri commands──▶  Rust (src-tauri/)  ──spawn──▶  rl inbox|data export|session … --json
   │                                          │                          (own session and process group)
   └── decodes raw bytes (JSON.parse)  ◀──────┘ returns stdout bytes unchanged
```

The frontend never runs a process and never reads ringleader's registry. Rust exposes eleven `#[tauri::command]`s (`rl_list`, `rl_scan`, `rl_tails`, `rl_decide`, `cached_list`, `app_info`, `resume_session`, `set_pending`, `close_ack`, `close_cancel`, `app_exit`) with fixed argument shapes. There is no shell plugin and no generic exec. Each command is registered in `src-tauri/build.rs` and permitted in `src-tauri/capabilities/default.json`.

Responses from `rl` (list, tails, outcome) and `cached_list` are passed through as raw bytes (`tauri::ipc::Response`, an `ArrayBuffer` in JS). Rust deserializes them only into a minimal `Envelope` (`kind`, `version`), so serde skips every other field, and rejects an unexpected kind or version. `src/api/client.ts` decodes with one module-level `TextDecoder` and `JSON.parse`; `src/api/types.ts` is the only typed consumer. `app_info` and `resume_session` return small Rust-built structs.

## The contract

Each `--json` call prints exactly one JSON document, `"version": 1`, snake_case keys:

- `list` — from `rl inbox --json`: every triage-relevant row with `in_recent` and `woke` flags, presence (`running` true, false or null when unknown), `lifecycle_block`, `mtime`, `file_fingerprint`, and the registry path.
  `rl inbox --json --scan` returns the same document with a `scan` key (added, removed, unavailable sources) filled in, so a scan returns the refreshed list; `scan` is `null` on a plain list.
- `tails` — from `rl data export ID … --json --max-chars=N`: one batched document for 1 to 16 ids; each item carries its own `mtime` and `file_fingerprint`, and an `unavailable` reason instead of failing the batch. Rust drops an id that is unsafe to pass as an argument (see Security) from the batch, or answers with an empty `tails` document without spawning when no id is left; `useTails` shows each dropped row as unavailable ("circus cannot pass this session id to rl").
- `outcome` — from `rl session <verb> ID --json --if-mtime=… [--if-fingerprint=…]` (`archive`, `delete`, `harvest --archive`, `snooze --until=…`, `keep`, `mark reviewed`): `ok`, `refused`, `empty` or `failed`, with `wrote`, for one action on one session. Circus only ever calls the guarded form and passes every value as `--flag=value`. Revalidation, presence refusal and locks are ringleader's.

Exit 0 means the requested document was printed (including refused outcomes); exit 1 carries an `error` document, which Rust reports as error kind `rl_error` with the document's message; an `rl` that predates the contract exits 2 with `unrecognized arguments: --json` or `unknown command` for one of the contract commands, which circus reports as "rl too old".

The source of truth is `docs/tech/json-contract.md` in the ringleader checkout (`../../ringleader/dev2`); this repo does not copy it. The golden documents ringleader generates live in `src/test/golden/` (copied by `just sync-golden`, compared by `just golden-check`) and are parsed by `src/api/golden.test.ts`. Rust fixtures in `src-tauri/tests/fixtures/` pin the envelope handling. To change the contract, change both sides together, then run `just sync-golden` and `just smoke-sandbox`.

## Finding and running `rl`

Resolution order: env `CIRCUS_RL` (shell-words; the sandbox points it at the ringleader checkout's `.venv/bin/rl`), then `rl_command` in `settings.json`, then one login-shell probe (`$SHELL -ilc`, sentinel markers, 5 s timeout after which the probe's group gets SIGKILL at once, off the main thread, skipped when `CIRCUS_RL` is set), then the first executable `rl` in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`. Resolution starts at launch on a background thread and commands wait on it. With `CIRCUS_ENV_LABEL` set, an unset, empty or unsplittable `CIRCUS_RL` resolves to a placeholder command that never runs, without probing or reading `settings.json`, so a labelled launch can never reach an installed `rl`.

Every `rl` child gets PATH explicitly: the current PATH first, then login-shell entries not already present. Resume launchers get the same resolved PATH (`resume::WithPath`).

## Subprocesses and deadlines

Children start with `setsid`, so each is its own session leader and process group (this also keeps the interactive login-shell probe off the terminal's tty under `tauri dev`). Each spawn names what its deadline does (`process::OnDeadline`). For `rl` calls and the iTerm2 launcher (`Terminate`) circus sends SIGTERM to the group, waits `KILL_GRACE` (5 s, longer than ringleader's own 2 s model-kill grace so `rl` can reap its model CLI first), sends SIGKILL to the group, always reaps, and never waits on pipe-drain threads past the grace. The login-shell probe (`Kill`) gets SIGKILL at once, because interactive shells ignore SIGTERM. A custom resume launcher (`Detach`) is spawned with null stdout and stderr, so a terminal that outlives circus never holds a pipe into it (EPIPE/SIGPIPE) and nothing stays captured; it is left running and reaped in the background. A launcher that fails within the grace is reported from its exit status alone. Deadlines are backstops: list 60 s, scan 300 s, tails 30 s, decide 120 s, harvest 420 s, iTerm2 resume launch 60 s; a custom launcher's 5 s is a grace, not a failure.

## Outbox and undo

`src/inbox/outbox.ts` and `useInbox.ts`. The outbox lives above the tabs (all four panels stay mounted).

- Windows: delete waits 10 s (ringleader's delete grace); every other decision 4 s. `z` cancels the newest decision not yet sent. Undo appears only on that decision's toast; decision toasts are never evicted.
- Lanes: the fast lane is serial; the harvest lane runs two at a time. At most one entry per session id.
- Rows hide optimistically. `ok` and any `wrote: true` outcome keep the row hidden through the `applied` bridge until a list (from `list()` or `scan()`) that started after the settle lands. `refused` or `failed` with `wrote: false`, and `empty`, restore the row.
- A decide that times out or dies without a document is unknown: the row stays hidden, a toast says "result unknown — refreshing", and a list refetch follows. An `error` document (`rl_error`, for example an ambiguous session id or a registry conflict) is a stated failure: the row comes back, the toast shows rl's message ("Archive “x” failed: …"), and a list refetch follows.
- List refetch rules: one `list()` after every refused, failed (including an `rl_error`), unknown or `wrote: true` outcome; a rescan (`scan()`) only for a refusal that says the session changed; `list()` and `scan()` on launch; `list()` on window focus when the last list is older than 60 s. Flights are single: a request during a flight queues one more. The list and scan flights share one sequence number, so a landed document is applied only if it started after the last applied one. A scan returns the refreshed list and is applied like a list, so a list refresh never waits behind a scan. After a scan lands, circus requests one more plain list when the scan's list was older than the last applied one, or when a list that started after the scan is still in flight; that in-flight list may have read the registry before the scan saved, so it is dropped when it lands and only the follow-up list replaces the scan's. A failed list that started before the last applied list does not show the load error. These landing rules are the pure `landList` in `useInbox.ts`; both list flights are built with `createSequencedFlight`, which requires the shared sequence.
- There is no automatic retry anywhere, and nothing is persisted: a crash or an uninterceptable quit drops unsent decisions, so nothing happens and the rows return on the next launch.
- In a sandbox, decisions are refused unless the list's registry lies under `CIRCUS_WORLD_ROOT`. Archive, delete and harvest are refused client-side for running or presence-unknown sessions and sessions without a fingerprint; archive, delete and harvest also for a non-null `lifecycle_block` (ringleader refuses the delete on the same transcript check, so the text is rewritten to `cannot delete …`). A null block does not guarantee a delete: a transcript outside its source's store is left to ringleader's own refusal.

## Close gate

`src-tauri/src/close.rs`, `lib.rs`, `src/inbox/FinishingOverlay.tsx`. The frontend reports pending plus in-flight work through `set_pending(n)` once its close listener is registered. With nothing pending, closing proceeds. Otherwise Rust prevents the close (red button, ⌘W, the custom ⌘Q item) and emits `circus://close-requested`. The event carries `finish_in_ms`, the time left before Rust quits on its own. The frontend acks (`close_ack`), sends unsent decisions at once, shows "Finishing N changes…" with a "Discard unsent" button (in-flight ones always finish) and calls `app_exit` when idle. The overlay names the clock time Rust will quit at and how many changes are still unsent: at that time unsent ones are dropped (they are back on the next launch) and ones being sent finish headless, since the harvest lane runs two at a time and a long queue of harvests can outlast the deadline. If `exit()` fails, the frontend calls `close_cancel`, which disarms the gate (the watchdog for that close round stops), then toasts "Could not quit", reopens the outbox and lets the next close start a fresh round. Rust exits on its own if no ack arrives within 5 s or no `app_exit` within 450 s of the round's first close request.

The Quit item is custom because the predefined one bypasses the gate. Dock › Quit and logout cannot be intercepted (tauri-apps/tauri#9198): unsent decisions are dropped, and `rl` processes already running finish headless.

## Shortcuts

`@shortcutkit/core` provides contexts and a registry (`src/shortcuts/contexts.ts`, in-memory store, no rebinding UI). Reading-pane buttons, the palette and the toast Undo button call `registry.dispatch`, so mouse and keys share one path (the toast falls back to `controller.undo()` while another tab hides the Inbox). The DOM host and React bindings in `src/shortcuts/` are temporary.

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

`resume_session` builds `rl resume <source:sessionId>` from the resolved `rl` command and runs it in iTerm2 through `osascript` (new window, `write text`), 60 s timeout so the first-run Automation prompt can be answered; the timeout message names iTerm2. `settings.json` `terminal_command` replaces the launcher. A custom launcher that exits 0 within 5 s, or is still running then (a terminal emulator that stays in the foreground, such as `alacritty -e` or `wezterm start`), counts as launched and is never killed; one that exits non-zero within 5 s is a `launch` error naming the launcher. `{command}` is one shell command line, so a launcher that runs argv needs a `sh -c` wrapper, for example `["wezterm", "start", "--", "sh", "-c", "{command}"]`. `src-tauri/Info.plist` carries `NSAppleEventsUsageDescription`. An osascript error `-1743` from the default launcher maps to a `launch` error naming System Settings › Privacy & Security › Automation; the same text from a custom launcher is not treated as a denial. `CIRCUS_RESUME_DRY_RUN=1` returns the command line instead of launching.

## Security

- CSP in `tauri.conf.json`: `default-src 'self'`, no remote scripts, `connect-src` limited to IPC and the dev server, `object-src 'none'`, `frame-ancestors 'none'`.
- Capability allowlist: only the eleven app commands plus `core:event:allow-listen` and `core:event:allow-unlisten` for the `main` window. `core:default` is not granted: its `core:menu:default` would let page script install a menu whose predefined Quit bypasses the close gate.
- Fixed argument shapes: times and fingerprints are length-limited and charset-checked before spawning; tail ids are capped at 16. Session ids come from transcript content, so they are checked only for argument safety: non-empty, at most 1 000 characters, no control characters (including NUL and newlines), not starting with `-`; `decide` also requires a qualified `<source>:<sessionId>` id. A failing id is dropped from a tails batch; decide and resume refuse it with `invalid_argument`.
- No shell plugin, no generic exec, no reading of `registry.json`.
- The sandbox decision guard refuses decisions when the registry is outside the world root.

## Settled decisions

Do not re-propose these without new evidence.

- **Spawn `rl`; no embedded logic, no sidecar.** Revalidation, presence refusal, lifecycle checks and locks stay in ringleader and are reached only through the `--json` commands; circus never reads `registry.json`, never calls a plain `rl session …` verb (only the guarded form) and has no generic exec. The price is a cold `rl` spawn per call, paid down by ringleader's lazy imports, batched tails, the list cache and prefetch. A persistent server is the next lever if that is not enough (see `docs/development.md`); it is deliberately not built.
- **Raw-bytes IPC.** Lists run to thousands of rows; deserializing them into a `serde_json::Value` tree and serializing again in Rust would cost more than the one `JSON.parse` in the webview. Rust types the requests and checks only the envelope.
- **Partition rules live in one place.** `rl inbox --json` returns every triage-relevant row with `in_recent` and `woke` flags; `src/inbox/derive.ts` partitions, orders, counts and groups. A row with a missing or malformed `mtime` makes the whole `list` an `error` document (the TUI fails the same way); there is no per-row skip.
- **Delete grace is the GUI's.** A guarded `rl session delete` acts at once; the 10 s window is the outbox's, mirroring the TUI's delete grace.
- **No outer lock around decide, one decision per session in flight.** Ringleader's ops take their own locks (a second `flock` in the same process would self-deadlock), so the outbox keeps at most one entry per session id and never retries.
- **No outbox persistence.** A crash or an uninterceptable quit drops unsent decisions: nothing happens and the rows return next launch. Replaying stale intent after a restart is the unsafe direction.
- **Single instance is not enforced.** A second `Circus` has its own outbox; ringleader revalidates every destructive op under its locks, so a decision made in both is refused or fails rather than applied twice.
- **Decisions on cached rows are allowed.** Ringleader revalidates `mtime` and fingerprint, so a stale cached row can only be refused.
- **No heavy frontend libraries.** No markdown renderer, date library or state-management library; `Intl.DateTimeFormat` instances are created once at module level. `requestIdleCallback` is not used (WKWebView lacks it).
- **Contract changes bump both sides together.** See `docs/development.md`.

## Performance

Budgets (enforced in `just check`):

| Budget                                                                                                                                    | Test                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Derive chain over 5 000 rows ≤ 8 ms; `indexRows` ≤ 25 ms                                                                                  | `src/inbox/derive.perf.test.ts`          |
| `parseSnooze` ≤ 0.2 ms per call                                                                                                           | `src/snooze/parse.perf.test.ts`          |
| One `j` keypress renders ≤ 3 rows with 5 000 rows                                                                                         | `src/inbox/InboxView.perf.test.tsx`      |
| `rl inbox --json` (with or without `--scan`) and `rl data export --json` stay off the heavy imports; the list over 2 000 threads ≤ 400 ms | ringleader `tests/test_contract_perf.py` |

Vitest budgets use real timers and the median of 21 runs after 5 warm-ups. QA targets (j/k keypress-to-paint under 16 ms at 2 000 rows, prefetched tail within one frame, cold first paint from the cache under 300 ms) are measured by hand; see `docs/development.md`.

How the budgets are met:

- Raw-bytes IPC with envelope-only validation (above): no `serde_json::Value` tree in Rust.
- List cache: after every successful list (`rl inbox --json`, scanned or not), Rust writes stdout atomically (temp file, then rename) to `<app_data_dir>/list-cache.json`. `cached_list` returns those bytes, or an empty body when there is no valid cache, without waiting for `rl` resolution. On launch the UI paints from it with a "Cached · refreshing…" chip, then revalidates. With `CIRCUS_ENV_LABEL` set the cache is `<CIRCUS_WORLD_ROOT>/.circus/list-cache.json`, and it is disabled when the label has no world root, so a sandbox never writes outside its world.
- Batched tail prefetch: the selected row plus neighbours −2..+5 of the visible order in one `tails` call, single flight, latest wins, into a 64-entry LRU keyed `(id, mtime, file_fingerprint)`. Prefetch is scheduled after the selection paints (`requestAnimationFrame`, then `setTimeout(0)`, coalesced while keys are held). When a landed tail no longer matches its row, the pane shows it labelled "May be out of date…" until the fresh one lands.
- Selection hot path: one synchronous state update per keypress with no awaits, timers or layout reads; scrollTop and viewport height live in refs fed by the scroll handler and a `ResizeObserver`. Rows are `React.memo` components keyed by id with props `row`, `selected` and one stable `onSelect`, in a fixed-height window. The derive chain is memoized on list, outbox entries, applied, split, project and query, never on the selection, and uses a per-list `RowIndex` (parsed mtime and lowercase haystack, built once per adopted list). Tails render as plain text in `<pre>` chunks with `content-visibility: auto`.
- Ringleader side: `inbox --json` and `export --json` import neither `textual`, `models`, `enrichment` nor `decisions`, and the guarded session verbs load their stack on demand.
