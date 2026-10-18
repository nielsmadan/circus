import {
  toCircusError,
  type CircusError,
  type DecideOutcome,
  type DecideRequest,
  type DecisionAction,
  type SessionRow,
} from '../api/types';

export type Lane = 'fast' | 'harvest';

export const UNDO_WINDOW_MS: Readonly<Record<DecisionAction, number>> = Object.freeze({
  harvest: 4_000,
  archive: 4_000,
  delete: 10_000,
  snooze: 4_000,
  keep: 4_000,
  keep_going: 4_000,
});

export const HARVEST_CONCURRENCY = 2;

export function laneOf(action: DecisionAction): Lane {
  return action === 'harvest' ? 'harvest' : 'fast';
}

export interface Decision {
  readonly ticket: number;
  readonly action: DecisionAction;
  readonly row: SessionRow;
  readonly until: string | null;
}

export type EntryState = 'pending' | 'queued' | 'sending';

export interface OutboxEntry {
  readonly decision: Decision;
  readonly state: EntryState;
  readonly sendAt: number;
}

export function classifyDecideError(error: CircusError): 'failed' | 'error' | 'unknown' {
  if (error.kind === 'rl_error') return 'failed';
  return error.kind === 'timeout' || error.kind === 'failed' || error.kind === 'bad_output'
    ? 'unknown'
    : 'error';
}

export type Settled =
  | { readonly kind: 'outcome'; readonly decision: Decision; readonly outcome: DecideOutcome }
  | { readonly kind: 'failed'; readonly decision: Decision; readonly error: CircusError }
  | { readonly kind: 'error'; readonly decision: Decision; readonly error: CircusError }
  | { readonly kind: 'unknown'; readonly decision: Decision; readonly error: CircusError };

export interface OutboxSnapshot {
  readonly entries: readonly OutboxEntry[];
  readonly closing: boolean;
}

export interface OutboxDeps {
  readonly send: (decision: Decision) => Promise<DecideOutcome>;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly onSettled: (settled: Settled) => void;
  readonly onError?: (error: unknown) => void;
}

export type EnqueueResult =
  | { readonly ok: true; readonly decision: Decision }
  | { readonly ok: false; readonly reason: 'closing' | 'duplicate' };

function isUnsent(entry: OutboxEntry): boolean {
  return entry.state === 'pending' || entry.state === 'queued';
}

function withState(entry: OutboxEntry, state: EntryState): OutboxEntry {
  return Object.freeze({ ...entry, state });
}

export class Outbox {
  private readonly deps: OutboxDeps;
  private entries: readonly OutboxEntry[] = Object.freeze([]);
  private closing = false;
  private nextTicket = 1;
  private readonly timers = new Map<number, unknown>();
  private readonly listeners = new Set<() => void>();
  private idleWaiters: (() => void)[] = [];
  private snapshot: OutboxSnapshot | null = null;

  constructor(deps: OutboxDeps) {
    this.deps = deps;
  }

  enqueue(action: DecisionAction, row: SessionRow, until: string | null = null): EnqueueResult {
    if (this.closing) return { ok: false, reason: 'closing' };
    if (this.entries.some((entry) => entry.decision.row.id === row.id)) {
      return { ok: false, reason: 'duplicate' };
    }
    const decision: Decision = Object.freeze({ ticket: this.nextTicket, action, row, until });
    this.nextTicket += 1;
    const delay = UNDO_WINDOW_MS[action];
    const entry: OutboxEntry = Object.freeze({
      decision,
      state: 'pending',
      sendAt: this.deps.now() + delay,
    });
    this.setEntries([...this.entries, entry]);
    this.timers.set(
      decision.ticket,
      this.deps.setTimer(() => this.due(decision.ticket), delay),
    );
    this.notify();
    return { ok: true, decision };
  }

  undo(): Decision | null {
    // entries stay in ticket order, so the last unsent one is the newest
    const newest = this.entries.findLast(isUnsent);
    if (newest === undefined) return null;
    this.clearTimerFor(newest.decision.ticket);
    this.setEntries(this.entries.filter((entry) => entry !== newest));
    this.notify();
    this.resolveIdle();
    return newest.decision;
  }

  flush(): void {
    const hadPending = this.entries.some((entry) => entry.state === 'pending');
    if (this.closing && !hadPending) return;
    this.closing = true;
    this.entries
      .filter((entry) => entry.state === 'pending')
      .forEach((entry) => this.clearTimerFor(entry.decision.ticket));
    this.setEntries(
      this.entries.map((entry) => (entry.state === 'pending' ? withState(entry, 'queued') : entry)),
    );
    this.notify();
    this.pump();
  }

  reopen(): void {
    if (!this.closing) return;
    this.closing = false;
    this.snapshot = null;
    this.notify();
  }

  discardUnsent(): readonly Decision[] {
    const removed = this.entries.filter(isUnsent);
    if (removed.length > 0) {
      removed.forEach((entry) => this.clearTimerFor(entry.decision.ticket));
      this.setEntries(this.entries.filter((entry) => !isUnsent(entry)));
      this.notify();
    }
    this.resolveIdle();
    return Object.freeze(removed.map((entry) => entry.decision));
  }

  whenIdle(): Promise<void> {
    if (this.entries.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  subscribe(listener: () => void): () => void {
    const wrapped = () => listener();
    this.listeners.add(wrapped);
    return () => {
      this.listeners.delete(wrapped);
    };
  }

  getSnapshot(): OutboxSnapshot {
    this.snapshot ??= Object.freeze({ entries: this.entries, closing: this.closing });
    return this.snapshot;
  }

  private setEntries(entries: readonly OutboxEntry[]): void {
    this.entries = Object.freeze(entries);
    this.snapshot = null;
  }

  private clearTimerFor(ticket: number): void {
    if (!this.timers.has(ticket)) return;
    this.deps.clearTimer(this.timers.get(ticket));
    this.timers.delete(ticket);
  }

  private due(ticket: number): void {
    this.timers.delete(ticket);
    const target = this.entries.find(
      (entry) => entry.decision.ticket === ticket && entry.state === 'pending',
    );
    if (target === undefined) return;
    this.setEntries(
      this.entries.map((entry) => (entry === target ? withState(entry, 'queued') : entry)),
    );
    this.notify();
    this.pump();
  }

  private pump(): void {
    const fastBusy = this.entries.some(
      (entry) => entry.state === 'sending' && laneOf(entry.decision.action) === 'fast',
    );
    const fast = fastBusy
      ? []
      : this.entries
          .filter((entry) => entry.state === 'queued' && laneOf(entry.decision.action) === 'fast')
          .slice(0, 1);
    const harvestSending = this.entries.filter(
      (entry) => entry.state === 'sending' && laneOf(entry.decision.action) === 'harvest',
    ).length;
    const harvest = this.entries
      .filter((entry) => entry.state === 'queued' && laneOf(entry.decision.action) === 'harvest')
      .slice(0, Math.max(0, HARVEST_CONCURRENCY - harvestSending));
    const starting = new Set([...fast, ...harvest]);
    if (starting.size === 0) return;
    this.setEntries(
      this.entries.map((entry) => (starting.has(entry) ? withState(entry, 'sending') : entry)),
    );
    this.notify();
    starting.forEach((entry) => this.send(entry.decision));
  }

  private send(decision: Decision): void {
    void Promise.resolve()
      .then(() => this.deps.send(decision))
      .then(
        (outcome): Settled => ({ kind: 'outcome', decision, outcome }),
        (raw: unknown): Settled => {
          const error = toCircusError(raw);
          return { kind: classifyDecideError(error), decision, error };
        },
      )
      .then((settled) => this.settle(settled));
  }

  private settle(settled: Settled): void {
    try {
      this.deps.onSettled(settled);
    } catch (error) {
      this.report(error);
    } finally {
      this.setEntries(
        this.entries.filter((entry) => entry.decision.ticket !== settled.decision.ticket),
      );
      this.notify();
      this.pump();
      this.resolveIdle();
    }
  }

  private notify(): void {
    [...this.listeners].forEach((listener) => {
      try {
        listener();
      } catch (error) {
        this.report(error);
      }
    });
  }

  private resolveIdle(): void {
    if (this.entries.length > 0 || this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  private report(error: unknown): void {
    (this.deps.onError ?? console.error)(error);
  }
}

export function toRequest(decision: Decision): DecideRequest {
  return {
    action: decision.action,
    id: decision.row.id,
    mtime: decision.row.mtime,
    fingerprint: decision.row.file_fingerprint,
    until: decision.until,
  };
}
