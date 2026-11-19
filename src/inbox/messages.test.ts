import { describe, expect, it } from 'vitest';
import type {
  CircusError,
  CircusErrorKind,
  DecideOutcome,
  DecisionAction,
  HandoffCode,
  OutcomeCode,
} from '../api/types';
import { makeRow } from '../test/fixtures';
import {
  alreadyPendingManyToast,
  batchEnqueuedToast,
  batchSettledToast,
  batchUndoToast,
  bulkConfirmText,
  enqueuedToast,
  errorDetail,
  handoffRefusalText,
  isChangedRefusal,
  isConfirmedAction,
  launchedToast,
  plural,
  refusalText,
  settledToast,
  skippedToast,
  undoToast,
} from './messages';
import type { Decision } from './outbox';

const row = makeRow({ label: 'fix flaky login', session_id: 's0' });
const NOW = new Date(2026, 9, 16, 14, 30);

function decision(action: DecisionAction, until: string | null = null): Decision {
  return { ticket: 1, batchId: 1, action, row, until };
}

function outcome(action: DecisionAction, overrides: Partial<DecideOutcome>): DecideOutcome {
  return {
    version: 1,
    kind: 'outcome',
    action,
    id: row.id,
    status: 'ok',
    code: null,
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

  it('says an unkeep returns the session to the inbox', () => {
    expect(enqueuedToast(decision('unkeep'), NOW).text).toBe(
      'Return “fix flaky login” to the inbox',
    );
    expect(batchEnqueuedToast('unkeep', 3, null, NOW).text).toBe('Return 3 sessions to the inbox');
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
    ['unkeep', 'Returned “fix flaky login” to the inbox'],
  ] as const)('reports an ok %s in the past tense', (action, text) => {
    expect(
      settledToast({ kind: 'outcome', decision: decision(action), outcome: outcome(action, {}) })
        .text,
    ).toBe(text);
  });

  it('says a session was not kept when an unkeep wrote nothing', () => {
    const toast = settledToast({
      kind: 'outcome',
      decision: decision('unkeep'),
      outcome: outcome('unkeep', { wrote: false }),
    });
    expect(toast).toEqual({
      tone: 'info',
      text: '“fix flaky login” isn’t kept',
      undo: false,
      detail: null,
    });
  });

  it('words every unkeep toast as a return to the inbox', () => {
    const failed = settledToast({
      kind: 'outcome',
      decision: decision('unkeep'),
      outcome: outcome('unkeep', { status: 'failed', code: 'other', wrote: false }),
    });
    const unknown = settledToast({
      kind: 'unknown',
      decision: decision('unkeep'),
      error: error('timeout', 'timed out'),
    });
    expect(failed.text).toBe('Couldn’t return “fix flaky login” to the inbox');
    expect(unknown.text).toBe('Return “fix flaky login” to the inbox: result unknown — refreshing');
    expect(undoToast(decision('unkeep')).text).toBe('Undid return “fix flaky login” to the inbox');
    expect(undoToast(null, decision('unkeep')).text).toBe(
      'Nothing to undo — return “fix flaky login” to the inbox was already sent',
    );
    expect(batchUndoToast('unkeep', { undone: 2, sent: 0 }).text).toBe(
      'Undid return of 2 sessions to the inbox',
    );
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
        code: 'changed',
        reason: 'changed since you looked: mtime moved',
        message: 'fix flaky login changed since you looked',
        wrote: false,
      }),
    });
    expect(toast).toMatchObject({
      text: '“fix flaky login” changed since you looked',
      detail: 'fix flaky login changed since you looked',
    });
  });

  it('adds the rescan note to a "changed since you looked" refusal', () => {
    const toast = settledToast({
      kind: 'outcome',
      decision: decision('archive'),
      outcome: outcome('archive', {
        status: 'refused',
        code: 'changed',
        reason: 'changed since you looked: mtime moved',
        message: 'fix flaky login changed since you looked',
        wrote: false,
      }),
    });
    expect(toast).toMatchObject({
      tone: 'warning',
      text: '“fix flaky login” changed since you looked — rescanning to pick up the change',
    });
  });

  it.each(['refused', 'failed'] as const)(
    'words a %s outcome itself and keeps the raw message as detail',
    (status) => {
      const toast = settledToast({
        kind: 'outcome',
        decision: decision('archive'),
        outcome: outcome('archive', { status, reason: 'odd', message: 'rl said no' }),
      });
      expect(toast).toMatchObject({
        tone: 'warning',
        text: 'Couldn’t archive “fix flaky login”',
        detail: 'rl said no',
      });
    },
  );

  it.each([
    ['running', '“fix flaky login” is still running — try again once it has stopped'],
    ['presence_unknown', 'Can’t tell whether “fix flaky login” is running, so it was left alone'],
    ['gone', '“fix flaky login” is gone — rescan to refresh the list'],
    ['lifecycle_blocked', '“fix flaky login” can’t be archived from Circus'],
    ['until_past', 'That snooze time has already passed'],
    [
      'no_harvest_model',
      'Harvesting needs a model, and none is set up — ⇧E archives “fix flaky login” without one',
    ],
    ['other', 'Couldn’t archive “fix flaky login”'],
  ] as const)('words the %s refusal in circus terms', (code, text) => {
    const toast = settledToast({
      kind: 'outcome',
      decision: decision('archive'),
      outcome: outcome('archive', { status: 'refused', code, reason: 'raw', message: 'raw' }),
    });
    expect(toast.text).toBe(text);
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
      expect(toast).toMatchObject({
        tone: 'error',
        text: 'Keep “fix flaky login” failed',
        detail: 'nope',
      });
    },
  );
});

describe('settledToast for an error document', () => {
  it('reports the failure and keeps the document’s message as detail', () => {
    const toast = settledToast({
      kind: 'failed',
      decision: decision('archive'),
      error: error('rl_error', 'ambiguous session id'),
    });
    expect(toast).toMatchObject({
      tone: 'warning',
      text: 'Archive “fix flaky login” failed',
      detail: 'ambiguous session id',
    });
  });
});

describe('undoToast', () => {
  it('names the undone decision', () => {
    expect(undoToast(decision('keep_going')).text).toBe('Undid keep going “fix flaky login”');
  });

  it('names the decision that was already sent', () => {
    expect(undoToast(null, decision('archive'))).toEqual({
      tone: 'info',
      text: 'Nothing to undo — archive “fix flaky login” was already sent',
      undo: false,
      detail: null,
    });
  });

  it('has no detail after any other decision', () => {
    expect(undoToast(null, decision('keep')).detail).toBeNull();
    expect(undoToast(null).detail).toBeNull();
  });
});

describe('refusalText', () => {
  const refused = (action: DecisionAction, code: OutcomeCode | null) =>
    refusalText(decision(action), outcome(action, { status: 'refused', code, wrote: false }));

  it.each([
    [
      'no_fingerprint',
      '“fix flaky login” changed since you looked — rescanning to pick up the change',
    ],
    ['transcript_missing', '“fix flaky login” has no transcript on disk any more'],
    ['until_invalid', 'That snooze time could not be read'],
    ['until_naive', 'That snooze time could not be read'],
    ['harvest_failed', 'Harvesting “fix flaky login” failed'],
    ['failed', 'Couldn’t archive “fix flaky login”'],
    [null, 'Couldn’t archive “fix flaky login”'],
  ] as const)('words %s', (code, text) => {
    expect(refused('archive', code)).toBe(text);
  });

  it('names delete for a lifecycle-blocked delete', () => {
    expect(refused('delete', 'lifecycle_blocked')).toBe(
      '“fix flaky login” can’t be deleted from Circus',
    );
  });

  it('falls back to the generic text for a code it does not know', () => {
    expect(refused('keep', 'brand_new' as OutcomeCode)).toBe('Couldn’t keep “fix flaky login”');
  });
});

describe('isChangedRefusal', () => {
  it.each([
    ['changed', true],
    ['no_fingerprint', true],
    ['running', false],
  ] as const)('%s → %s', (code, changed) => {
    expect(isChangedRefusal(outcome('archive', { status: 'refused', code }))).toBe(changed);
  });
});

describe('batch toasts', () => {
  it('names the count and the action of a bulk decision', () => {
    expect(batchEnqueuedToast('archive', 3, null, NOW)).toEqual({
      tone: 'info',
      text: 'Archive 3 sessions',
      undo: true,
      detail: null,
    });
  });

  it('counts down a bulk delete', () => {
    expect(batchEnqueuedToast('delete', 2, null, NOW).text).toBe('Deleting 2 sessions in 10 s');
  });

  it('shows when a bulk snooze wakes', () => {
    const until = new Date(2026, 9, 17, 9, 0).toISOString();
    expect(batchEnqueuedToast('snooze', 2, until, NOW).text).toBe(
      'Snooze 2 sessions until Tomorrow, 09:00',
    );
  });

  it('sums up a settled batch in the past tense', () => {
    expect(batchSettledToast('keep_going', 1).text).toBe('Kept going 1 session');
    expect(batchSettledToast('unkeep', 2).text).toBe('Returned 2 sessions to the inbox');
  });

  it('says how many were undone and how many were already sent', () => {
    expect(batchUndoToast('archive', { undone: 2, sent: 1 }).text).toBe(
      'Undid archive of 2 sessions (1 already sent)',
    );
    expect(batchUndoToast('keep', { undone: 3, sent: 0 }).text).toBe('Undid keep of 3 sessions');
  });

  it('agrees the verb with the number of sessions already pending', () => {
    expect(alreadyPendingManyToast(1).text).toBe('1 session already has a pending change');
    expect(alreadyPendingManyToast(2).text).toBe('2 sessions already have a pending change');
  });

  it('shows a lone skip reason as is and lists several in the detail', () => {
    const row = makeRow();
    expect(skippedToast({ row, reason: 'x is running' }, [])).toEqual({
      tone: 'warning',
      text: 'x is running',
      undo: false,
      detail: null,
    });
    expect(
      skippedToast({ row, reason: 'a is running' }, [{ row, reason: 'b has no fingerprint' }]),
    ).toEqual({
      tone: 'warning',
      text: 'Skipped 2 sessions',
      undo: false,
      detail: 'a is running\nb has no fingerprint',
    });
  });
});

describe('bulk confirmation', () => {
  it('confirms a bulk delete as destructive and a bulk archive as normal', () => {
    expect(bulkConfirmText('delete', 2)).toEqual({
      title: 'Delete 2 sessions permanently?',
      detail: 'Nothing is harvested.',
      confirmLabel: 'Delete 2',
      tone: 'destructive',
    });
    expect(bulkConfirmText('archive', 3)).toEqual({
      title: 'Archive 3 sessions?',
      detail: null,
      confirmLabel: 'Archive 3',
      tone: 'normal',
    });
  });

  it('asks before harvesting, archiving or deleting', () => {
    expect(
      (['harvest', 'archive', 'delete', 'snooze', 'keep', 'keep_going'] as const).filter(
        isConfirmedAction,
      ),
    ).toEqual(['harvest', 'archive', 'delete']);
  });
});

describe('hand-off and launch text', () => {
  it.each([
    ['nothing_to_triage', 'Nothing in proj-01 is waiting for triage'],
    ['agent_not_installed', 'codex isn’t installed'],
    ['brand_new', 'Couldn’t start triage of proj-01'],
  ] as const)('words the %s refusal', (code, text) => {
    expect(handoffRefusalText(code as HandoffCode, 'proj-01', 'codex')).toBe(text);
  });

  it('names the terminal it opened in, and the command of a dry run', () => {
    expect(
      launchedToast({ command: 'x', launched: true, via: 'iterm2' }, '“fix parser”'),
    ).toMatchObject({ text: 'Opened “fix parser” in iTerm2', detail: null });
    expect(launchedToast({ command: 'x', launched: true, via: 'custom' }, 'it').text).toBe(
      'Opened it in the terminal',
    );
    expect(launchedToast({ command: 'run x', launched: false, via: 'iterm2' }, 'it')).toMatchObject(
      { text: 'Dry run — would open it', detail: 'run x' },
    );
  });
});

describe('plural and errorDetail', () => {
  it('pluralises a noun by count', () => {
    expect([0, 1, 2].map((n) => plural(n, 'harvest'))).toEqual([
      '0 harvests',
      '1 harvest',
      '2 harvests',
    ]);
  });

  it('adds the stderr tail to the message when there is one', () => {
    expect(errorDetail(error('failed', 'Could not turn on'))).toBe('Could not turn on');
    expect(
      errorDetail({ ...error('failed', 'Could not turn on'), stderr_tail: 'claude: no hook' }),
    ).toBe('Could not turn on\nclaude: no hook');
    expect(errorDetail({ ...error('failed', 'Could not turn on'), stderr_tail: '' })).toBe(
      'Could not turn on',
    );
  });
});
