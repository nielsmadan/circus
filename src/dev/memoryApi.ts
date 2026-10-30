import type { CircusApi } from '../api/client';
import {
  TAIL_CHARS,
  TAIL_MAX_IDS,
  type AppInfo,
  type CircusError,
  type DecideOutcome,
  type DecideRequest,
  type ListResponse,
  type SessionRow,
  type TailItem,
} from '../api/types';

export interface MemoryApi extends CircusApi {
  requestClose(): void;
}

export interface MemoryApiOptions {
  readonly latencyMs?: number;
  readonly harvestDelayMs?: number;
  readonly cache?: boolean;
}

const FAKE_WORLD = '/fake/world';
const FAKE_REGISTRY = `${FAKE_WORLD}/xdg-data/ringleader/registry.json`;
const CACHE_DELAY_MS = 5;
const HOUR_MS = 3_600_000;
const FINISH_TIMEOUT_MS = 450_000;
const TAIL_TARGET_CHARS = 12_000;
const DESTRUCTIVE: ReadonlySet<string> = new Set(['archive', 'delete', 'harvest']);
const CHANGED = 'changed since you looked';
const NO_STAMP = `${CHANGED}: no fingerprint, rescan`;
const GONE = 'no longer in the registry';
const FINGERPRINT = /^\d+(?::\d+){4}$/;
const HAS_OFFSET = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i;
const TIME_CHARS = /^[0-9T:.+\-Z]{1,64}$/;

const REPLIES = Object.freeze([
  'Looked at the failing test and traced it to a stale fixture.',
  'Updated the parser to keep trailing whitespace and added a regression test.',
  'Ran the suite: everything passes except one flaky timing check.',
  'The cache key now includes the fingerprint, so a rescan invalidates it.',
  'Refactored the export into a pure function and moved the I/O to the caller.',
  'Checked the docs; the flag was renamed two releases ago.',
  'Reverted the experiment and left a note in the plan.',
]);

const APP_INFO: AppInfo = {
  rl_command: ['rl'],
  rl_source: 'env',
  shell_probe: 'skipped',
  environment_label: 'fake',
  world_root: FAKE_WORLD,
  resume_dry_run: true,
  terminal: 'iterm2',
  settings_path: `${FAKE_WORLD}/settings.json`,
};

function hashOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return hash;
}

function fakeTail(row: SessionRow): string {
  const seed = hashOf(row.id);
  const prompt = row.last_prompt ?? row.label;
  const blocks: string[] = [];
  let length = 0;
  for (let turn = 0; length < TAIL_TARGET_CHARS; turn += 1) {
    const reply = REPLIES[(seed + turn) % REPLIES.length] ?? '';
    const block = `## USER\n${prompt} (turn ${turn + 1})\n\n## ASSISTANT\n${reply}\n${reply}\n\n`;
    blocks.push(block);
    length += block.length;
  }
  return blocks.join('');
}

function invalid(message: string): CircusError {
  return { kind: 'invalid_argument', message, exit_code: null, stderr_tail: null };
}

function outcome(
  request: DecideRequest,
  fields: Pick<DecideOutcome, 'status' | 'message'> & Partial<DecideOutcome>,
): DecideOutcome {
  return {
    version: 1,
    kind: 'outcome',
    action: request.action,
    id: request.id,
    reason: null,
    wrote: false,
    path: null,
    warnings: [],
    ...fields,
  };
}

function refusedOutcome(
  request: DecideRequest,
  reason: string,
  message: string = reason,
): DecideOutcome {
  return outcome(request, { status: 'refused', reason, message });
}

// ringleader computes lifecycle_block for archive; the same transcript check names each operation
function lifecycleReason(row: SessionRow, action: string): string | null {
  const block = row.lifecycle_block;
  if (block === null) return null;
  return block.startsWith('cannot archive ') ? `cannot ${action} ${block.slice(15)}` : block;
}

function runningReason(row: SessionRow): string | null {
  if (row.running === true) {
    return `${row.label} is running — finish it from inside with the ringleader-finish skill`;
  }
  if (row.running === null) {
    return `can't tell whether ${row.label} is running — install presence with rl data presence install`;
  }
  return null;
}

// the order of guarded.decide: stamp, gone, lifecycle, changed, then presence
function destructiveRefusal(
  request: DecideRequest,
  row: SessionRow | undefined,
): DecideOutcome | null {
  if (request.fingerprint === null || !FINGERPRINT.test(request.fingerprint)) {
    return refusedOutcome(request, NO_STAMP);
  }
  if (row === undefined) {
    return request.action === 'harvest'
      ? refusedOutcome(request, GONE)
      : refusedOutcome(request, GONE, `${request.id}: ${GONE}`);
  }
  const lifecycle = lifecycleReason(row, request.action);
  if (lifecycle !== null) return refusedOutcome(request, lifecycle);
  if (request.mtime !== row.mtime) {
    return request.action === 'harvest'
      ? refusedOutcome(request, CHANGED)
      : refusedOutcome(request, CHANGED, `${row.label}: ${CHANGED}`);
  }
  const running = runningReason(row);
  return running === null ? null : refusedOutcome(request, running);
}

function untilRefusal(request: DecideRequest, nowMs: number): DecideOutcome | null {
  const until = request.until ?? '';
  const parsed = Date.parse(until);
  if (Number.isNaN(parsed)) {
    return refusedOutcome(request, `--until is not an ISO 8601 time: '${until}'`);
  }
  if (!HAS_OFFSET.test(until)) return refusedOutcome(request, '--until needs a timezone offset');
  if (parsed <= nowMs) return refusedOutcome(request, 'snooze time must be in the future');
  return null;
}

function rustRejection(request: DecideRequest): CircusError | null {
  if (request.action === 'snooze') {
    if (request.until === null) return invalid('snooze needs an until time');
    if (!TIME_CHARS.test(request.until))
      return invalid(`invalid until: ${JSON.stringify(request.until)}`);
  } else if (request.until !== null) {
    return invalid(`until is only valid for snooze, not ${request.action}`);
  }
  return null;
}

function okPath(request: DecideRequest, row: SessionRow): string | null {
  if (request.action === 'harvest') return `${FAKE_WORLD}/harvests/${row.session_id}.md`;
  if (request.action === 'archive') return `${FAKE_WORLD}/archive/${row.session_id}.jsonl`;
  return null;
}

function decideInMemory(
  rows: readonly SessionRow[],
  request: DecideRequest,
  nowMs: number,
): { readonly outcome: DecideOutcome; readonly rows: readonly SessionRow[] } {
  const row = rows.find((candidate) => candidate.id === request.id);
  const refused = DESTRUCTIVE.has(request.action)
    ? destructiveRefusal(request, row)
    : request.action === 'snooze'
      ? untilRefusal(request, nowMs)
      : null;
  if (refused !== null) return { outcome: refused, rows };
  if (row === undefined) {
    return {
      outcome: outcome(request, { status: 'failed', message: `${request.id}: ${GONE}` }),
      rows,
    };
  }
  if (request.action === 'harvest' && row.project_short.endsWith('proj-00')) {
    return {
      outcome: outcome(request, { status: 'empty', message: 'nothing worth harvesting' }),
      rows,
    };
  }
  return {
    outcome: outcome(request, {
      status: 'ok',
      message: `${request.action.replace('_', ' ')}: ${row.label}`,
      wrote: true,
      path: okPath(request, row),
    }),
    rows: rows.filter((candidate) => candidate !== row),
  };
}

export function createMemoryApi(seed: ListResponse, options: MemoryApiOptions = {}): MemoryApi {
  const latencyMs = options.latencyMs ?? 150;
  const harvestDelayMs = options.harvestDelayMs ?? 1_500;
  const cache = options.cache ?? true;
  let current: readonly SessionRow[] = [...seed.sessions];
  let closeHandler: ((finishInMs: number | null) => void) | null = null;

  const after = <T>(ms: number, produce: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(produce());
        } catch (error) {
          reject(error as Error);
        }
      }, ms);
    });

  const listOf = (generatedAt: string, sessions: readonly SessionRow[]): ListResponse => ({
    ...seed,
    generated_at: generatedAt,
    registry: FAKE_REGISTRY,
    sessions: sessions as SessionRow[],
  });

  const tailItem = (id: string, row: SessionRow | undefined): TailItem =>
    row === undefined
      ? {
          id,
          text: '',
          max_chars: TAIL_CHARS,
          truncated: false,
          unavailable: 'no longer in the registry',
          mtime: null,
          file_fingerprint: null,
        }
      : {
          id,
          text: fakeTail(row),
          max_chars: TAIL_CHARS,
          truncated: false,
          unavailable: null,
          mtime: row.mtime,
          file_fingerprint: row.file_fingerprint,
        };

  return {
    list: () => after(latencyMs, () => listOf(new Date().toISOString(), current)),
    scan: () =>
      after(2 * latencyMs, () => {
        const scannedAt = new Date().toISOString();
        return {
          ...listOf(scannedAt, current),
          scan: { scanned_at: scannedAt, added: 0, removed: 0, unavailable_sources: [] },
        };
      }),
    tails: (ids) => {
      if (ids.length === 0 || ids.length > TAIL_MAX_IDS) {
        return Promise.reject(invalid(`tails takes 1 to ${TAIL_MAX_IDS} ids`));
      }
      return after(latencyMs, () => {
        const byId = new Map(current.map((row) => [row.id, row]));
        return { version: 1, kind: 'tails', items: ids.map((id) => tailItem(id, byId.get(id))) };
      });
    },
    cachedList: () =>
      after(CACHE_DELAY_MS, () =>
        cache ? listOf(new Date(Date.now() - HOUR_MS).toISOString(), [...seed.sessions]) : null,
      ),
    decide: (request) => {
      const rejected = rustRejection(request);
      if (rejected !== null) return Promise.reject(rejected);
      return after(request.action === 'harvest' ? harvestDelayMs : latencyMs, () => {
        const result = decideInMemory(current, request, Date.now());
        current = result.rows;
        return result.outcome;
      });
    },
    resume: (id) =>
      after(latencyMs, () => ({ command: `rl resume ${id}`, launched: false, via: 'iterm2' })),
    appInfo: () => after(latencyMs, () => APP_INFO),
    setPending: (count) =>
      after(latencyMs, () => {
        console.debug(`[fake] set_pending ${count}`);
      }),
    closeAck: () =>
      after(latencyMs, () => {
        console.debug('[fake] close_ack');
      }),
    closeCancel: () =>
      after(latencyMs, () => {
        console.debug('[fake] close_cancel');
      }),
    exit: () =>
      after(latencyMs, () => {
        document.body.textContent = 'Circus exited (fake)';
      }),
    onCloseRequested: (handler) =>
      after(latencyMs, () => {
        closeHandler = handler;
        return () => {
          if (closeHandler === handler) closeHandler = null;
        };
      }),
    requestClose: () => {
      closeHandler?.(FINISH_TIMEOUT_MS);
    },
  };
}
