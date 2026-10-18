import { describe, expect, it } from 'vitest';
import type { CircusError, CircusErrorKind, DecideOutcome, DecisionAction } from '../api/types';
import { makeRow } from '../test/fixtures';
import { enqueuedToast, settledToast, undoToast, verb } from './messages';
import type { Decision } from './outbox';

const row = makeRow({ label: 'fix flaky login', session_id: 's0' });
const NOW = new Date(2026, 9, 16, 14, 30);

function decision(action: DecisionAction, until: string | null = null): Decision {
  return { ticket: 1, action, row, until };
}

function outcome(action: DecisionAction, overrides: Partial<DecideOutcome>): DecideOutcome {
  return {
    version: 1,
    kind: 'outcome',
    action,
    id: row.id,
    status: 'ok',
    reason: null,
    message: 'done',
    wrote: true,
    path: null,
    warnings: [],
    ...overrides,
  };
}

function error(kind: CircusErrorKind, message: string): CircusError {
  return { kind, message, exit_code: null, stderr_tail: null };
}

describe('verb', () => {
  it.each([
    ['harvest', 'Harvest'],
    ['archive', 'Archive'],
    ['delete', 'Delete'],
    ['snooze', 'Snooze'],
    ['keep', 'Keep'],
    ['keep_going', 'Keep going'],
  ] as const)('%s → %s', (action, text) => {
    expect(verb(action)).toBe(text);
  });
});

describe('enqueuedToast', () => {
  it('names the decision with an undo', () => {
    expect(enqueuedToast(decision('archive'), NOW)).toEqual({
      tone: 'info',
      text: 'Archive “fix flaky login”',
      undo: true,
      detail: null,
    });
  });

  it('counts down a delete', () => {
    expect(enqueuedToast(decision('delete'), NOW).text).toBe('Deleting “fix flaky login” in 10 s');
  });

  it('shows when a snooze wakes', () => {
    const until = new Date(2026, 9, 17, 9, 0).toISOString();
    expect(enqueuedToast(decision('snooze', until), NOW).text).toBe(
      'Snooze “fix flaky login” until Tomorrow, 09:00',
    );
  });
});

describe('settledToast', () => {
  it('reports a harvest with its saved path', () => {
    const toast = settledToast({
      kind: 'outcome',
      decision: decision('harvest'),
      outcome: outcome('harvest', { path: '/h/fix.md' }),
    });
    expect(toast).toEqual({
      tone: 'info',
      text: 'Harvested “fix flaky login”',
      undo: false,
      detail: '/h/fix.md',
    });
  });

  it.each([
    ['archive', 'Archived “fix flaky login”'],
    ['delete', 'Deleted “fix flaky login”'],
    ['snooze', 'Snoozed “fix flaky login”'],
    ['keep', 'Kept “fix flaky login”'],
    ['keep_going', 'Kept going “fix flaky login”'],
  ] as const)('reports an ok %s in the past tense', (action, text) => {
    expect(
      settledToast({ kind: 'outcome', decision: decision(action), outcome: outcome(action, {}) })
        .text,
    ).toBe(text);
  });

  it('puts warnings in the detail', () => {
    const toast = settledToast({
      kind: 'outcome',
      decision: decision('archive'),
      outcome: outcome('archive', { warnings: ['index stale', 'slow disk'] }),
    });
    expect(toast.detail).toBe('index stale\nslow disk');
  });

  it('promises no rescan when a failed outcome says changed since you looked', () => {
    const toast = settledToast({
      kind: 'outcome',
      decision: decision('archive'),
      outcome: outcome('archive', {
        status: 'failed',
        reason: 'changed since you looked: mtime moved',
        message: 'fix flaky login changed since you looked',
        wrote: false,
      }),
    });
    expect(toast.text).toBe('fix flaky login changed since you looked');
  });

  it('adds the rescan note to a "changed since you looked" refusal', () => {
    const toast = settledToast({
      kind: 'outcome',
      decision: decision('archive'),
      outcome: outcome('archive', {
        status: 'refused',
        reason: 'changed since you looked: mtime moved',
        message: 'fix flaky login changed since you looked',
        wrote: false,
      }),
    });
    expect(toast).toMatchObject({
      tone: 'warning',
      text: 'fix flaky login changed since you looked — rescanning to pick up the change',
    });
  });

  it.each(['refused', 'failed'] as const)('shows the message of a %s outcome', (status) => {
    const toast = settledToast({
      kind: 'outcome',
      decision: decision('archive'),
      outcome: outcome('archive', { status, reason: 'running', message: 'it is running' }),
    });
    expect(toast).toMatchObject({ tone: 'warning', text: 'it is running' });
  });

  it('explains an empty harvest', () => {
    const toast = settledToast({
      kind: 'outcome',
      decision: decision('harvest'),
      outcome: outcome('harvest', { status: 'empty', wrote: false }),
    });
    expect(toast).toMatchObject({
      tone: 'info',
      text: 'Nothing worth harvesting in “fix flaky login” — ⇧E archives it without a harvest',
    });
  });

  it.each(['timeout', 'failed', 'bad_output'] as const)('treats %s as unknown', (kind) => {
    const toast = settledToast({
      kind: 'unknown',
      decision: decision('delete'),
      error: error(kind, 'no document'),
    });
    expect(toast).toMatchObject({
      tone: 'warning',
      text: 'Delete “fix flaky login”: result unknown — refreshing',
      detail: 'no document',
    });
  });

  it.each(['rl_not_found', 'rl_too_old', 'invalid_argument', 'launch'] as const)(
    'reports %s as a failure',
    (kind) => {
      const toast = settledToast({
        kind: 'error',
        decision: decision('keep'),
        error: error(kind, 'nope'),
      });
      expect(toast).toMatchObject({ tone: 'error', text: 'Keep “fix flaky login” failed: nope' });
    },
  );
});

describe('undoToast', () => {
  it('names the undone decision', () => {
    expect(undoToast(decision('keep_going')).text).toBe('Undid keep going “fix flaky login”');
  });

  it('points at unarchive when the last sent decision was an archive', () => {
    expect(undoToast(null, decision('archive'))).toEqual({
      tone: 'info',
      text: 'Nothing to undo — already sent',
      undo: false,
      detail: 'rl session unarchive s0 brings an archive back',
    });
  });

  it('has no detail after any other decision', () => {
    expect(undoToast(null, decision('keep')).detail).toBeNull();
    expect(undoToast(null).detail).toBeNull();
  });
});
