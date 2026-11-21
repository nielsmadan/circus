import type { DecisionAction } from '../api/types';
import { batchSettledToast, type ToastSpec } from './messages';
import { unchangedState, type Settled } from './outbox';

export interface BatchProgress {
  readonly action: DecisionAction;
  readonly size: number;
  readonly remaining: number;
  readonly ok: number;
}

export type MemberEnd = 'ok' | 'not_ok' | 'undone';

export interface BatchAdvance {
  readonly progress: BatchProgress | null;
  readonly summary: ToastSpec | null;
}

export function startBatch(action: DecisionAction, size: number): BatchProgress {
  return { action, size, remaining: size, ok: 0 };
}

export function memberEnd(settled: Settled): MemberEnd {
  return settled.kind === 'outcome' &&
    settled.outcome.status === 'ok' &&
    unchangedState(settled.decision, settled.outcome) === null
    ? 'ok'
    : 'not_ok';
}

export function advanceBatch(progress: BatchProgress, end: MemberEnd): BatchAdvance {
  const next = {
    ...progress,
    remaining: progress.remaining - 1,
    ok: progress.ok + (end === 'ok' ? 1 : 0),
  };
  if (next.remaining > 0) return { progress: next, summary: null };
  return { progress: null, summary: next.ok > 0 ? batchSettledToast(next.action, next.ok) : null };
}

export function alreadySent(progress: BatchProgress, undone: number): number {
  return progress.size - undone;
}
