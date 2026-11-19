import { describe, expect, it } from 'vitest';
import type { DecideOutcome } from '../api/types';
import { makeRow } from '../test/fixtures';
import { advanceBatch, alreadySent, memberEnd, startBatch, type MemberEnd } from './batches';
import type { Decision } from './outbox';

const play = (size: number, ends: readonly MemberEnd[]) =>
  ends.reduce(
    (state, end) => {
      if (state.progress === null) throw new Error('batch already finished');
      return advanceBatch(state.progress, end);
    },
    { progress: startBatch('archive', size), summary: null } as ReturnType<typeof advanceBatch>,
  );

describe('advanceBatch', () => {
  it('waits for every member before summing up', () => {
    expect(play(3, ['ok', 'ok'])).toEqual({
      progress: { action: 'archive', size: 3, remaining: 1, ok: 2 },
      summary: null,
    });
  });

  it('sums up only the members that went through', () => {
    expect(play(3, ['ok', 'not_ok', 'ok'])).toEqual({
      progress: null,
      summary: { tone: 'info', text: 'Archived 2 sessions', undo: false, detail: null },
    });
  });

  it('has no summary when every member failed', () => {
    expect(play(2, ['not_ok', 'not_ok'])).toEqual({ progress: null, summary: null });
  });

  it('sums up the sent members once the rest are undone', () => {
    expect(play(3, ['ok', 'undone', 'undone']).summary?.text).toBe('Archived 1 session');
  });
});

describe('alreadySent', () => {
  it('counts every member that was not undone as sent', () => {
    const progress = advanceBatch(startBatch('keep', 3), 'ok').progress;
    if (progress === null) throw new Error('finished early');
    expect(alreadySent(progress, 1)).toBe(2);
  });
});

describe('memberEnd', () => {
  const decision: Decision = {
    ticket: 1,
    batchId: 1,
    action: 'archive',
    row: makeRow(),
    until: null,
  };

  it('counts only an ok outcome as ok', () => {
    const outcome: DecideOutcome = {
      version: 1,
      status: 'ok',
      kind: 'outcome',
      action: 'archive',
      id: decision.row.id,
      code: null,
      reason: null,
      message: 'done',
      wrote: true,
      path: null,
      warnings: [],
    };
    expect(memberEnd({ kind: 'outcome', decision, outcome: { ...outcome, status: 'ok' } })).toBe(
      'ok',
    );
    expect(
      memberEnd({ kind: 'outcome', decision, outcome: { ...outcome, status: 'refused' } }),
    ).toBe('not_ok');
    expect(
      memberEnd({
        kind: 'unknown',
        decision,
        error: { kind: 'timeout', message: 't', exit_code: null, stderr_tail: null },
      }),
    ).toBe('not_ok');
  });

  it('counts an unkeep of a row that was not kept as not ok', () => {
    const unkeep: Decision = { ...decision, action: 'unkeep' };
    const outcome: DecideOutcome = {
      version: 1,
      status: 'ok',
      kind: 'outcome',
      action: 'unkeep',
      id: decision.row.id,
      code: null,
      reason: null,
      message: 'not kept',
      wrote: false,
      path: null,
      warnings: [],
    };
    expect(memberEnd({ kind: 'outcome', decision: unkeep, outcome })).toBe('not_ok');
    expect(
      memberEnd({ kind: 'outcome', decision: unkeep, outcome: { ...outcome, wrote: true } }),
    ).toBe('ok');
  });
});
