import type { CircusApi } from '../api/client';
import {
  TAIL_CHARS,
  TAIL_MAX_IDS,
  type AppInfo,
  type CircusError,
  type DecideOutcome,
  type AgentInfo,
  type DecideRequest,
  type DecisionAction,
  type HandoffCode,
  type HandoffResponse,
  type ListResponse,
  type OutcomeCode,
  type SetupPrefs,
  type InstallState,
  type SetupStatus,
  type SessionRow,
  type TailItem,
} from '../api/types';
import { isKept, lifecycleText, listedRows, parseMtime } from '../inbox/derive';
import { fakeHome } from './fakeHome';
import { keptRow, snoozedRow, unkeptRow, unsnoozedRow, type FakeWorld } from './synthetic';

export interface MemoryApi extends CircusApi {
  requestClose(): void;
}

export interface MemoryApiOptions {
  readonly latencyMs?: number;
  readonly harvestDelayMs?: number;
  readonly cache?: boolean;
  readonly setup?: InstallState;
  readonly onboarded?: boolean;
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

const FAKE_AGENTS: readonly AgentInfo[] = Object.freeze([
  { source: 'claude-code', agent: 'claude', installed: true },
  { source: 'codex', agent: 'codex', installed: true },
  { source: 'pi', agent: 'pi', installed: false },
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
  home_dir: '/u',
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
    code: null,
    reason: null,
    wrote: false,
    path: null,
    warnings: [],
    ...fields,
  };
}

function refusedOutcome(
  request: DecideRequest,
  code: OutcomeCode,
  reason: string,
  message: string = reason,
): DecideOutcome {
  return outcome(request, { status: 'refused', code, reason, message });
}

function lifecycleReason(row: SessionRow, action: DecisionAction): string | null {
  return row.lifecycle_block === null ? null : lifecycleText(row.lifecycle_block, action);
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
    return refusedOutcome(request, 'no_fingerprint', NO_STAMP);
  }
  if (row === undefined) {
    return request.action === 'harvest'
      ? refusedOutcome(request, 'gone', GONE)
      : refusedOutcome(request, 'gone', GONE, `${request.id}: ${GONE}`);
  }
  const lifecycle = lifecycleReason(row, request.action);
  if (lifecycle !== null) return refusedOutcome(request, 'lifecycle_blocked', lifecycle);
  if (request.mtime !== row.mtime) {
    return request.action === 'harvest'
      ? refusedOutcome(request, 'changed', CHANGED)
      : refusedOutcome(request, 'changed', CHANGED, `${row.label}: ${CHANGED}`);
  }
  const running = runningReason(row);
  if (running === null) return null;
  return refusedOutcome(request, row.running === true ? 'running' : 'presence_unknown', running);
}

function untilRefusal(request: DecideRequest, nowMs: number): DecideOutcome | null {
  const until = request.until ?? '';
  const parsed = Date.parse(until);
  if (Number.isNaN(parsed)) {
    return refusedOutcome(request, 'until_invalid', `--until is not an ISO 8601 time: '${until}'`);
  }
  if (!HAS_OFFSET.test(until)) {
    return refusedOutcome(request, 'until_naive', '--until needs a timezone offset');
  }
  if (parsed <= nowMs)
    return refusedOutcome(request, 'until_past', 'snooze time must be in the future');
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

type World = FakeWorld;

function activeSnooze(row: SessionRow, nowMs: number): boolean {
  return (
    row.snoozed_at !== null && (row.snoozed_until === null || parseMtime(row.snoozed_until) > nowMs)
  );
}

function settledWorld(world: World, row: SessionRow, request: DecideRequest, nowMs: number): World {
  const others = (rows: readonly SessionRow[]) => rows.filter((candidate) => candidate !== row);
  const rest = {
    sessions: others(world.sessions),
    kept: others(world.kept),
    snoozed: others(world.snoozed),
  };
  const now = new Date(nowMs).toISOString();
  switch (request.action) {
    case 'keep':
      return { ...rest, kept: [...rest.kept, keptRow(row, now)] };
    case 'unkeep':
      return { ...rest, sessions: [...rest.sessions, unkeptRow(row)] };
    case 'snooze': {
      const snoozed = snoozedRow(row, now, request.until);
      return isKept(row)
        ? { ...rest, kept: [...rest.kept, snoozed] }
        : { ...rest, snoozed: [...rest.snoozed, snoozed] };
    }
    case 'wake': {
      const woken = unsnoozedRow(row);
      return isKept(row)
        ? { ...rest, kept: [...rest.kept, woken] }
        : { ...rest, sessions: [...rest.sessions, woken] };
    }
    case 'archive':
    case 'delete':
    case 'harvest':
    case 'keep_going':
      return rest;
  }
}

function listedWorld(world: World, nowMs: number): World {
  const expired = world.snoozed.filter((row) => !activeSnooze(row, nowMs));
  if (expired.length === 0) return world;
  const active = world.snoozed.filter((row) => activeSnooze(row, nowMs));
  return {
    ...world,
    sessions: [...world.sessions, ...expired.map((row) => ({ ...row, woke: true }))],
    snoozed: active,
  };
}

function decideInMemory(
  world: World,
  request: DecideRequest,
  nowMs: number,
): { readonly outcome: DecideOutcome; readonly world: World } {
  const row = listedRows(world).find((candidate) => candidate.id === request.id);
  const refused = DESTRUCTIVE.has(request.action)
    ? destructiveRefusal(request, row)
    : request.action === 'snooze'
      ? untilRefusal(request, nowMs)
      : null;
  if (refused !== null) return { outcome: refused, world };
  if (row === undefined) {
    return {
      outcome: outcome(request, {
        status: 'failed',
        code: 'gone',
        message: `${request.id}: ${GONE}`,
      }),
      world,
    };
  }
  if (request.action === 'harvest' && row.project_short.endsWith('proj-00')) {
    return {
      outcome: outcome(request, { status: 'empty', message: 'nothing worth harvesting' }),
      world,
    };
  }
  if (request.action === 'unkeep' && !isKept(row)) {
    return {
      outcome: outcome(request, { status: 'ok', message: `${row.label} is not kept` }),
      world,
    };
  }
  if (request.action === 'wake' && !activeSnooze(row, nowMs)) {
    return {
      outcome: outcome(request, { status: 'ok', message: `${row.label} is not snoozed` }),
      world,
    };
  }
  return {
    outcome: outcome(request, {
      status: 'ok',
      message: `${request.action.replace('_', ' ')}: ${row.label}`,
      wrote: true,
      path: okPath(request, row),
    }),
    world: settledWorld(world, row, request, nowMs),
  };
}

export function createMemoryApi(seed: ListResponse, options: MemoryApiOptions = {}): MemoryApi {
  const latencyMs = options.latencyMs ?? 150;
  const harvestDelayMs = options.harvestDelayMs ?? 1_500;
  const cache = options.cache ?? true;
  const seedWorld: World = {
    sessions: [...seed.sessions],
    kept: [...(seed.kept ?? [])],
    snoozed: [...(seed.snoozed ?? [])],
  };
  let current: World = seedWorld;
  let pendingHarvests = 0;
  const initialSetup = options.setup ?? 'current';
  const requirements = { minimum: '0.2.0', latest: '0.3.0', uv_available: true, can_install: true };
  const installedVersion = { too_old: '0.1.0', outdated: '0.2.0', current: '0.3.0' } as const;
  let setup: SetupStatus =
    initialSetup === 'missing'
      ? { ...requirements, state: 'missing', installed: null }
      : { ...requirements, state: initialSetup, installed: installedVersion[initialSetup] };
  let prefs: SetupPrefs = { onboarded: options.onboarded ?? true, prompt_updates: true };
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

  const listOf = (generatedAt: string, stored: World): ListResponse => {
    const world = listedWorld(stored, Date.parse(generatedAt));
    return {
      ...seed,
      generated_at: generatedAt,
      registry: FAKE_REGISTRY,
      agents: [...FAKE_AGENTS],
      home: fakeHome(world, pendingHarvests, seed.roundup.stale),
      sessions: [...world.sessions],
      kept: [...world.kept],
      snoozed: [...world.snoozed],
    };
  };

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
        const byId = new Map(listedRows(current).map((row) => [row.id, row]));
        return { version: 1, kind: 'tails', items: ids.map((id) => tailItem(id, byId.get(id))) };
      });
    },
    cachedList: () =>
      after(CACHE_DELAY_MS, () =>
        cache ? listOf(new Date(Date.now() - HOUR_MS).toISOString(), seedWorld) : null,
      ),
    decide: (request) => {
      const rejected = rustRejection(request);
      if (rejected !== null) return Promise.reject(rejected);
      return after(request.action === 'harvest' ? harvestDelayMs : latencyMs, () => {
        const result = decideInMemory(current, request, Date.now());
        current = result.world;
        if (request.action === 'harvest' && result.outcome.status === 'ok') pendingHarvests += 1;
        return result.outcome;
      });
    },
    resume: (id) =>
      after(latencyMs, () => ({ command: `rl resume ${id}`, launched: false, via: 'iterm2' })),
    previewHandoff: (request) =>
      after(latencyMs, (): HandoffResponse => {
        const known = listedWorld(current, Date.now()).sessions.some(
          (row) => row.project_key === request.project_key,
        );
        const agent = FAKE_AGENTS.find((entry) => entry.source === request.agent);
        const name = agent?.agent ?? request.agent;
        const document = {
          version: 1,
          kind: 'handoff',
          purpose: 'triage',
          source: request.agent,
          agent: name,
          project_key: request.project_key,
        } as const;
        const code: HandoffCode | null = !known
          ? 'nothing_to_triage'
          : agent?.installed !== true
            ? 'agent_not_installed'
            : null;
        return code === null
          ? {
              ...document,
              status: 'ok',
              code: null,
              reason: null,
              cwd: request.project_key,
              argv: [name, 'triage prompt'],
            }
          : {
              ...document,
              status: 'refused',
              code,
              reason: `handoff refused: ${code}`,
              cwd: null,
              argv: null,
            };
      }),
    launchHandoff: (request) =>
      after(latencyMs, () => ({
        command: `rl handoff triage --project=${request.project_key} --agent=${request.agent}`,
        launched: false,
        via: 'iterm2' as const,
      })),
    appInfo: () => after(latencyMs, () => APP_INFO),
    setupStatus: () => after(latencyMs, () => setup),
    installRingleader: () =>
      after(harvestDelayMs, () => {
        setup = { ...setup, state: 'current', installed: setup.latest };
        return setup;
      }),
    installUv: () =>
      after(harvestDelayMs, () => {
        setup = { ...setup, uv_available: true };
        return setup;
      }),
    setupPrefs: () => after(latencyMs, () => prefs),
    installPresence: () => after(harvestDelayMs, () => undefined),
    installAgentExtras: () => after(harvestDelayMs, () => undefined),
    saveSetupPrefs: (next) =>
      after(latencyMs, () => {
        prefs = next;
      }),
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
