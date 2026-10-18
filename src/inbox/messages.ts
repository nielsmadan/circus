import type { DecideOutcome, DecisionAction } from '../api/types';
import { formatSnoozeTime } from '../snooze/parse';
import type { Decision, Settled } from './outbox';

export type ToastTone = 'info' | 'warning' | 'error';

export interface ToastSpec {
  readonly tone: ToastTone;
  readonly text: string;
  readonly undo: boolean;
  readonly detail: string | null;
}

const VERBS: Readonly<Record<DecisionAction, string>> = Object.freeze({
  harvest: 'Harvest',
  archive: 'Archive',
  delete: 'Delete',
  snooze: 'Snooze',
  keep: 'Keep',
  keep_going: 'Keep going',
});

const PAST: Readonly<Record<DecisionAction, string>> = Object.freeze({
  harvest: 'Harvested',
  archive: 'Archived',
  delete: 'Deleted',
  snooze: 'Snoozed',
  keep: 'Kept',
  keep_going: 'Kept going',
});

const CHANGED = 'changed since you looked';

export function isChangedRefusal(outcome: DecideOutcome): boolean {
  return outcome.status === 'refused' && outcome.reason?.startsWith(CHANGED) === true;
}

export function verb(action: DecisionAction): string {
  return VERBS[action];
}

const quoted = (decision: Decision): string => `“${decision.row.label}”`;

function toast(tone: ToastTone, text: string, detail: string | null = null): ToastSpec {
  return { tone, text, undo: false, detail };
}

export function enqueuedToast(decision: Decision, now: Date = new Date()): ToastSpec {
  const label = quoted(decision);
  const text =
    decision.action === 'delete'
      ? `Deleting ${label} in 10 s`
      : decision.action === 'snooze' && decision.until !== null
        ? `Snooze ${label} until ${formatSnoozeTime(new Date(decision.until), now)}`
        : `${verb(decision.action)} ${label}`;
  return { tone: 'info', text, undo: true, detail: null };
}

function joinDetail(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null && part !== '');
  return present.length === 0 ? null : present.join('\n');
}

function outcomeToast(decision: Decision, outcome: DecideOutcome): ToastSpec {
  const label = quoted(decision);
  switch (outcome.status) {
    case 'ok': {
      const path = decision.action === 'harvest' ? outcome.path : null;
      return toast(
        'info',
        `${PAST[decision.action]} ${label}`,
        joinDetail([path, ...outcome.warnings]),
      );
    }
    case 'refused':
    case 'failed': {
      const suffix = isChangedRefusal(outcome) ? ' — rescanning to pick up the change' : '';
      return toast('warning', `${outcome.message}${suffix}`, joinDetail(outcome.warnings));
    }
    case 'empty':
      return toast(
        'info',
        `Nothing worth harvesting in ${label} — ⇧E archives it without a harvest`,
      );
  }
}

export function settledToast(settled: Settled): ToastSpec {
  const { decision } = settled;
  switch (settled.kind) {
    case 'outcome':
      return outcomeToast(decision, settled.outcome);
    case 'unknown':
      return toast(
        'warning',
        `${verb(decision.action)} ${quoted(decision)}: result unknown — refreshing`,
        settled.error.message,
      );
    case 'failed':
      return toast(
        'warning',
        `${verb(decision.action)} ${quoted(decision)} failed: ${settled.error.message}`,
      );
    case 'error':
      return toast(
        'error',
        `${verb(decision.action)} ${quoted(decision)} failed: ${settled.error.message}`,
      );
  }
}

export function undoToast(decision: Decision | null, lastSent: Decision | null = null): ToastSpec {
  if (decision !== null) {
    return toast('info', `Undid ${verb(decision.action).toLowerCase()} ${quoted(decision)}`);
  }
  const detail =
    lastSent?.action === 'archive'
      ? `rl session unarchive ${lastSent.row.session_id} brings an archive back`
      : null;
  return toast('info', 'Nothing to undo — already sent', detail);
}
