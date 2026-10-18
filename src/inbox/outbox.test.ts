import { describe, expect, it, vi } from 'vitest';
import type { CircusError, DecideOutcome, DecisionAction } from '../api/types';
import { makeRow } from '../test/fixtures';
import { Outbox, toRequest, type Decision, type Settled } from './outbox';

interface Timer {
  readonly at: number;
  readonly callback: () => void;
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, Timer>();
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    timerCount: () => timers.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
  };
}

interface Deferred {
  readonly decision: Decision;
  resolve(outcome: DecideOutcome): void;
  reject(error: unknown): void;
}

function outcomeFor(decision: Decision): DecideOutcome {
  return {
    version: 1,
    kind: 'outcome',
    action: decision.action,
    id: decision.row.id,
    status: 'ok',
    reason: null,
    message: 'done',
    wrote: true,
    path: null,
    warnings: [],
  };
}

function circusError(kind: CircusError['kind']): CircusError {
  return { kind, message: kind, exit_code: null, stderr_tail: null };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(overrides: { onSettled?: (settled: Settled) => void } = {}) {
  const clock = fakeClock();
  const sends: Deferred[] = [];
  const settled: Settled[] = [];
  const errors: unknown[] = [];
  const send = vi.fn(
    (decision: Decision) =>
      new Promise<DecideOutcome>((resolve, reject) => {
        sends.push({ decision, resolve, reject });
      }),
  );
  const outbox = new Outbox({
    send,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onSettled: overrides.onSettled ?? ((s) => settled.push(s)),
    onError: (error) => errors.push(error),
  });
  const enqueue = (action: DecisionAction, id: string) => {
    const result = outbox.enqueue(action, makeRow({ id }));
    if (!result.ok) throw new Error(`enqueue refused: ${result.reason}`);
    return result.decision;
  };
  return { clock, outbox, send, sends, settled, errors, enqueue };
}

describe('Outbox', () => {
  it('sends an archive at 4 000 ms and not before', async () => {
    const { clock, send, enqueue } = setup();
    const decision = enqueue('archive', 'claude-code:a');
    clock.advance(3_999);
    await settle();
    expect(send).not.toHaveBeenCalled();
    clock.advance(1);
    await settle();
    expect(send).toHaveBeenCalledWith(decision);
  });

  it('sends a delete at 10 000 ms', async () => {
    const { clock, send, enqueue } = setup();
    enqueue('delete', 'claude-code:a');
    clock.advance(9_999);
    await settle();
    expect(send).toHaveBeenCalledTimes(0);
    clock.advance(1);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('undoes a pending archive so it is never sent', async () => {
    const { clock, outbox, send, enqueue } = setup();
    const decision = enqueue('archive', 'claude-code:a');
    clock.advance(3_999);
    expect(outbox.undo()).toBe(decision);
    clock.advance(10_000);
    await settle();
    expect(send).toHaveBeenCalledTimes(0);
    expect(outbox.getSnapshot().entries).toEqual([]);
  });

  it('undoes the newer of two pending decisions', () => {
    const { outbox, enqueue } = setup();
    const older = enqueue('archive', 'claude-code:a');
    const newer = enqueue('keep', 'claude-code:b');
    expect(outbox.undo()).toBe(newer);
    expect(outbox.getSnapshot().entries.map((entry) => entry.decision)).toEqual([older]);
  });

  it('clears the timer and resolves idle waiters when undo empties the outbox', async () => {
    const { clock, outbox, enqueue } = setup();
    enqueue('archive', 'claude-code:a');
    const idle = vi.fn();
    void outbox.whenIdle().then(idle);
    outbox.undo();
    await settle();
    expect(idle).toHaveBeenCalledTimes(1);
    expect(clock.timerCount()).toBe(0);
  });

  it('does not undo a sending entry', async () => {
    const { clock, outbox, enqueue } = setup();
    enqueue('archive', 'claude-code:a');
    clock.advance(4_000);
    await settle();
    expect(outbox.undo()).toBeNull();
    expect(outbox.getSnapshot().entries.map((entry) => entry.state)).toEqual(['sending']);
  });

  it('undoes a newer queued entry and leaves the older sending one', async () => {
    const { clock, outbox, enqueue } = setup();
    enqueue('archive', 'claude-code:a');
    clock.advance(4_000);
    await settle();
    const newer = enqueue('keep', 'claude-code:b');
    expect(outbox.undo()).toBe(newer);
    expect(outbox.getSnapshot().entries.map((entry) => entry.decision.row.id)).toEqual([
      'claude-code:a',
    ]);
  });

  it('returns null from undo when nothing is unsent', () => {
    expect(setup().outbox.undo()).toBeNull();
  });

  it('refuses a second decision for the same row, also while it is sending', async () => {
    const { clock, outbox, enqueue } = setup();
    enqueue('archive', 'claude-code:a');
    expect(outbox.enqueue('keep', makeRow({ id: 'claude-code:a' }))).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    clock.advance(4_000);
    await settle();
    expect(outbox.getSnapshot().entries[0]?.state).toBe('sending');
    expect(outbox.enqueue('keep', makeRow({ id: 'claude-code:a' }))).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('sends two fast decisions one after the other', async () => {
    const { clock, sends, enqueue } = setup();
    const first = enqueue('archive', 'claude-code:a');
    const second = enqueue('keep', 'claude-code:b');
    clock.advance(4_000);
    await settle();
    expect(sends.map((s) => s.decision)).toEqual([first]);
    sends[0]?.resolve(outcomeFor(first));
    await settle();
    expect(sends.map((s) => s.decision)).toEqual([first, second]);
  });

  it('runs at most two harvests at once', async () => {
    const { clock, sends, enqueue } = setup();
    const harvests = ['a', 'b', 'c'].map((id) => enqueue('harvest', `claude-code:${id}`));
    clock.advance(4_000);
    await settle();
    expect(sends.map((s) => s.decision)).toEqual(harvests.slice(0, 2));
    sends[1]?.resolve(outcomeFor(harvests[1] as Decision));
    await settle();
    expect(sends.map((s) => s.decision)).toEqual([harvests[0], harvests[1], harvests[2]]);
  });

  it('sends a fast decision while a harvest is in flight', async () => {
    const { clock, sends, enqueue } = setup();
    const harvest = enqueue('harvest', 'claude-code:a');
    const archive = enqueue('archive', 'claude-code:b');
    clock.advance(4_000);
    await settle();
    expect(sends.map((s) => s.decision)).toEqual([harvest, archive]);
  });

  it('sends pending decisions at once on flush and then refuses new ones', async () => {
    const { outbox, sends, enqueue } = setup();
    const decision = enqueue('delete', 'claude-code:a');
    outbox.flush();
    await settle();
    expect(sends.map((s) => s.decision)).toEqual([decision]);
    expect(outbox.getSnapshot().closing).toBe(true);
    expect(outbox.enqueue('keep', makeRow({ id: 'claude-code:b' }))).toEqual({
      ok: false,
      reason: 'closing',
    });
  });

  it('accepts decisions again after reopen', async () => {
    const { outbox, enqueue } = setup();
    enqueue('delete', 'claude-code:a');
    outbox.flush();
    await settle();
    outbox.reopen();
    expect(outbox.getSnapshot().closing).toBe(false);
    expect(outbox.enqueue('keep', makeRow({ id: 'claude-code:b' })).ok).toBe(true);
  });

  it('discards the queued decision during a flush and goes idle once the sending one settles', async () => {
    const { outbox, sends, settled, enqueue } = setup();
    const sending = enqueue('archive', 'claude-code:a');
    const queued = enqueue('keep', 'claude-code:b');
    outbox.flush();
    await settle();
    expect(outbox.getSnapshot().entries.map((entry) => entry.state)).toEqual(['sending', 'queued']);
    expect(outbox.discardUnsent()).toEqual([queued]);
    const idle = vi.fn();
    void outbox.whenIdle().then(idle);
    await settle();
    expect(idle).not.toHaveBeenCalled();
    sends[0]?.resolve(outcomeFor(sending));
    await settle();
    expect(idle).toHaveBeenCalledOnce();
    expect(settled.map((s) => s.decision)).toEqual([sending]);
    expect(sends).toHaveLength(1);
  });

  it('resolves whenIdle at once when empty', async () => {
    await expect(setup().outbox.whenIdle()).resolves.toBeUndefined();
  });

  it('settles an outcome with the decision and its document', async () => {
    const { clock, sends, settled, enqueue } = setup();
    const decision = enqueue('keep', 'claude-code:a');
    clock.advance(4_000);
    await settle();
    sends[0]?.resolve(outcomeFor(decision));
    await settle();
    expect(settled).toEqual([{ kind: 'outcome', decision, outcome: outcomeFor(decision) }]);
  });

  it.each([
    ['timeout', 'unknown'],
    ['failed', 'unknown'],
    ['bad_output', 'unknown'],
    ['rl_error', 'failed'],
    ['invalid_argument', 'error'],
  ] as const)('classifies a rejected %s as %s', async (errorKind, settledKind) => {
    const { clock, sends, settled, enqueue } = setup();
    const decision = enqueue('archive', 'claude-code:a');
    clock.advance(4_000);
    await settle();
    sends[0]?.reject(circusError(errorKind));
    await settle();
    expect(settled).toEqual([{ kind: settledKind, decision, error: circusError(errorKind) }]);
  });

  it('settles a non-CircusError rejection as unknown', async () => {
    const { clock, sends, settled, enqueue } = setup();
    const decision = enqueue('archive', 'claude-code:a');
    clock.advance(4_000);
    await settle();
    sends[0]?.reject(new Error('x'));
    await settle();
    expect(settled).toEqual([
      {
        kind: 'unknown',
        decision,
        error: { kind: 'failed', message: 'Error: x', exit_code: null, stderr_tail: null },
      },
    ]);
  });

  it('settles a synchronously throwing send as an error and still sends the next one', async () => {
    const clock = fakeClock();
    const settled: Settled[] = [];
    const sent: Decision[] = [];
    const outbox = new Outbox({
      send: (decision) => {
        sent.push(decision);
        if (sent.length === 1) throw circusError('invalid_argument');
        return Promise.resolve(outcomeFor(decision));
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onSettled: (s) => settled.push(s),
    });
    outbox.enqueue('archive', makeRow({ id: 'claude-code:a' }));
    outbox.enqueue('keep', makeRow({ id: 'claude-code:b' }));
    clock.advance(4_000);
    await settle();
    expect(settled.map((s) => [s.kind, s.decision.row.id])).toEqual([
      ['error', 'claude-code:a'],
      ['outcome', 'claude-code:b'],
    ]);
  });

  it('reports a throwing onSettled and still sends the next queued entry', async () => {
    const boom = new Error('boom');
    const { clock, sends, errors, enqueue } = setup({
      onSettled: () => {
        throw boom;
      },
    });
    const first = enqueue('archive', 'claude-code:a');
    const second = enqueue('keep', 'claude-code:b');
    clock.advance(4_000);
    await settle();
    sends[0]?.resolve(outcomeFor(first));
    await settle();
    expect(errors).toEqual([boom]);
    expect(sends.map((s) => s.decision)).toEqual([first, second]);
  });

  it('reports a throwing listener and keeps notifying the others', () => {
    const { outbox, errors, enqueue } = setup();
    const boom = new Error('listener');
    const other = vi.fn();
    outbox.subscribe(() => {
      throw boom;
    });
    outbox.subscribe(other);
    enqueue('keep', 'claude-code:a');
    expect(errors).toEqual([boom]);
    expect(other).toHaveBeenCalledOnce();
  });

  it('keeps the same snapshot until something changes', () => {
    const { outbox, enqueue } = setup();
    const empty = outbox.getSnapshot();
    expect(outbox.getSnapshot()).toBe(empty);
    enqueue('keep', 'claude-code:a');
    const one = outbox.getSnapshot();
    expect(one).not.toBe(empty);
    expect(outbox.getSnapshot()).toBe(one);
    expect(Object.isFrozen(one)).toBe(true);
    expect(one.entries[0]).toMatchObject({ state: 'pending', sendAt: 4_000 });
  });

  it('stops notifying after unsubscribe', () => {
    const { outbox, enqueue } = setup();
    const listener = vi.fn();
    const unsubscribe = outbox.subscribe(listener);
    enqueue('keep', 'claude-code:a');
    unsubscribe();
    enqueue('keep', 'claude-code:b');
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('toRequest', () => {
  it('builds the decide request from the row it was enqueued with', () => {
    const row = makeRow({ id: 'claude-code:a', mtime: '2026-10-01T00:00:00+00:00' });
    const decision: Decision = { ticket: 1, action: 'snooze', row, until: '2026-11-01T09:00:00Z' };
    expect(toRequest(decision)).toEqual({
      action: 'snooze',
      id: 'claude-code:a',
      mtime: '2026-10-01T00:00:00+00:00',
      fingerprint: row.file_fingerprint,
      until: '2026-11-01T09:00:00Z',
    });
  });
});
