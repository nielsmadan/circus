import type {
  CircusError,
  DecideOutcome,
  DecisionAction,
  HandoffCode,
  SessionRow,
  TerminalLaunch,
} from '../api/types';
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

export const unknownValue = (_value: never): null => null;

export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

export const sessions = (count: number): string => plural(count, 'session');

export const quote = (label: string): string => `“${label}”`;

const quoted = (decision: Decision): string => quote(decision.row.label);

export function isChangedRefusal(outcome: DecideOutcome): boolean {
  return (
    outcome.status === 'refused' &&
    (outcome.code === 'changed' || outcome.code === 'no_fingerprint')
  );
}

export function verb(action: DecisionAction): string {
  return VERBS[action];
}

export const errorDetail = (error: CircusError): string =>
  error.stderr_tail === null || error.stderr_tail === ''
    ? error.message
    : `${error.message}\n${error.stderr_tail}`;

export function toast(tone: ToastTone, text: string, detail: string | null = null): ToastSpec {
  return { tone, text, undo: false, detail };
}

const DECISIONS_OFF = 'so archive, delete and harvest are off for now';

export const PRESENCE_TEXT = `Can’t tell which sessions are running, ${DECISIONS_OFF}.`;

export const presenceUnknownText = (label: string): string =>
  `Can’t tell whether ${label} is running, ${DECISIONS_OFF}`;

export const stillRunningText = (label: string): string =>
  `${label} is still running — try again once it has stopped`;

function enqueuedText(
  action: DecisionAction,
  subject: string,
  until: string | null,
  now: Date,
): string {
  if (action === 'delete') return `Deleting ${subject} in 10 s`;
  if (action === 'snooze' && until !== null) {
    return `Snooze ${subject} until ${formatSnoozeTime(new Date(until), now)}`;
  }
  return `${verb(action)} ${subject}`;
}

export function enqueuedToast(decision: Decision, now: Date = new Date()): ToastSpec {
  const text = enqueuedText(decision.action, quoted(decision), decision.until, now);
  return { tone: 'info', text, undo: true, detail: null };
}

export function batchEnqueuedToast(
  action: DecisionAction,
  count: number,
  until: string | null,
  now: Date = new Date(),
): ToastSpec {
  return {
    tone: 'info',
    text: enqueuedText(action, sessions(count), until, now),
    undo: true,
    detail: null,
  };
}

export function batchSettledToast(action: DecisionAction, ok: number): ToastSpec {
  return toast('info', `${PAST[action]} ${sessions(ok)}`);
}

export interface BatchUndo {
  readonly undone: number;
  readonly sent: number;
}

export function batchUndoToast(action: DecisionAction, { undone, sent }: BatchUndo): ToastSpec {
  const tail = sent > 0 ? ` (${sent} already sent)` : '';
  return toast('info', `Undid ${verb(action).toLowerCase()} of ${sessions(undone)}${tail}`);
}

export interface Skipped {
  readonly row: SessionRow;
  readonly reason: string;
}

export function skippedToast(first: Skipped, rest: readonly Skipped[]): ToastSpec {
  if (rest.length === 0) return toast('warning', first.reason);
  const all = [first, ...rest];
  return toast(
    'warning',
    `Skipped ${sessions(all.length)}`,
    all.map((entry) => entry.reason).join('\n'),
  );
}

export const blockedToast = (reason: string): ToastSpec => toast('warning', reason);

export const alreadyPendingToast = (label: string): ToastSpec =>
  toast('info', `${quote(label)} already has a pending change`);

export const alreadyPendingManyToast = (count: number): ToastSpec =>
  toast('info', `${sessions(count)} already ${count === 1 ? 'has' : 'have'} a pending change`);

export const oneHarvestToast = (): ToastSpec =>
  toast('warning', 'Harvest one session at a time — unmark all but one');

export const oneResumeToast = (): ToastSpec =>
  toast('warning', 'Resume one session at a time — unmark all but one');

export const oneProjectToast = (): ToastSpec =>
  toast('warning', 'The marked sessions are in several projects — triage one project at a time');

export const rescanQueuedToast = (): ToastSpec => toast('info', 'Rescan queued');

export const rescanFailedToast = (detail: string): ToastSpec =>
  toast('warning', 'Rescan failed', detail);

export const sourcesUnavailableToast = (sources: readonly string[]): ToastSpec =>
  toast('warning', `Sources unavailable: ${sources.join(', ')}`);

export const appInfoFailedToast = (detail: string): ToastSpec =>
  toast('error', 'Couldn’t read the app settings', detail);

export const quitFailedToast = (detail: string): ToastSpec =>
  toast('error', 'Couldn’t quit', detail);

function joinDetail(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null && part !== '');
  return present.length === 0 ? null : present.join('\n');
}

export function refusalText(decision: Decision, outcome: DecideOutcome): string {
  const label = quoted(decision);
  const failed = `Couldn’t ${verb(decision.action).toLowerCase()} ${label}`;
  switch (outcome.code) {
    case 'changed':
    case 'no_fingerprint':
      return outcome.status === 'refused'
        ? `${label} changed since you looked — rescanning to pick up the change`
        : `${label} changed since you looked`;
    case 'gone':
      return `${label} is gone — rescan to refresh the list`;
    case 'transcript_missing':
      return `${label} has no transcript on disk any more`;
    case 'running':
      return stillRunningText(label);
    case 'presence_unknown':
      return `Can’t tell whether ${label} is running, so it was left alone`;
    case 'lifecycle_blocked':
      return `${label} can’t be ${decision.action === 'delete' ? 'deleted' : 'archived'} from Circus`;
    case 'until_invalid':
    case 'until_naive':
      return 'That snooze time could not be read';
    case 'until_past':
      return 'That snooze time has already passed';
    case 'no_harvest_model':
      return `Harvesting needs a model, and none is set up — ⇧E archives ${label} without one`;
    case 'harvest_failed':
      return `Harvesting ${label} failed`;
    case 'failed':
    case 'other':
    case null:
      return failed;
    default:
      unknownValue(outcome.code);
      return failed;
  }
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
    case 'failed':
      return toast(
        'warning',
        refusalText(decision, outcome),
        joinDetail([outcome.message, ...outcome.warnings]),
      );
    case 'empty':
      return toast(
        'info',
        `Nothing worth harvesting in ${label} — ⇧E archives it without a harvest`,
      );
  }
}

export function settledToast(settled: Settled): ToastSpec {
  const { decision } = settled;
  const subject = `${verb(decision.action)} ${quoted(decision)}`;
  switch (settled.kind) {
    case 'outcome':
      return outcomeToast(decision, settled.outcome);
    case 'unknown':
      return toast('warning', `${subject}: result unknown — refreshing`, settled.error.message);
    case 'failed':
    case 'error':
      return toast(
        settled.kind === 'error' ? 'error' : 'warning',
        `${subject} failed`,
        settled.error.message,
      );
  }
}

export function undoToast(decision: Decision | null, lastSent: Decision | null = null): ToastSpec {
  if (decision !== null) {
    return toast('info', `Undid ${verb(decision.action).toLowerCase()} ${quoted(decision)}`);
  }
  const text =
    lastSent === null
      ? 'Nothing to undo'
      : `Nothing to undo — ${verb(lastSent.action).toLowerCase()} ${quoted(lastSent)} was already sent`;
  return toast('info', text);
}

function launchedText(launch: TerminalLaunch, what: string): string {
  if (!launch.launched) return `Dry run — would open ${what}`;
  return `Opened ${what} in ${launch.via === 'iterm2' ? 'iTerm2' : 'the terminal'}`;
}

export const launchedToast = (launch: TerminalLaunch, what: string): ToastSpec =>
  toast('info', launchedText(launch, what), launch.launched ? null : launch.command);

export const resumeFailedToast = (label: string, detail: string): ToastSpec =>
  toast('error', `Couldn’t resume ${quote(label)}`, detail);

const triageFailedText = (projectLabel: string): string =>
  `Couldn’t start triage of ${projectLabel}`;

export function handoffRefusalText(code: HandoffCode, projectLabel: string, agent: string): string {
  switch (code) {
    case 'nothing_to_triage':
      return `Nothing in ${projectLabel} is waiting for triage`;
    case 'agent_not_installed':
      return `${agent} isn’t installed`;
    default:
      unknownValue(code);
      return triageFailedText(projectLabel);
  }
}

export const triageFailedToast = (projectLabel: string, detail: string): ToastSpec =>
  toast('error', triageFailedText(projectLabel), detail);

export const noAgentToast = (): ToastSpec =>
  toast('warning', 'No agent is installed to triage with');

export const presenceOnToast = (): ToastSpec => toast('info', 'Running-session detection is on');

export const presenceFailedToast = (detail: string): ToastSpec =>
  toast('error', 'Couldn’t turn on running-session detection', detail);

export const presenceOffToast = (detail: string): ToastSpec =>
  toast(
    'warning',
    'Running-session detection is off — turn it on from the banner above the inbox',
    detail,
  );

export type ConfirmedAction = 'archive' | 'delete';

export function isConfirmedAction(action: DecisionAction): action is ConfirmedAction {
  return action === 'archive' || action === 'delete';
}

export interface ConfirmText {
  readonly title: string;
  readonly detail: string | null;
  readonly confirmLabel: string;
  readonly tone: 'destructive' | 'normal';
}

export function bulkConfirmText(action: ConfirmedAction, count: number): ConfirmText {
  switch (action) {
    case 'delete':
      return {
        title: `Delete ${sessions(count)} permanently?`,
        detail: 'Nothing is harvested.',
        confirmLabel: `Delete ${count}`,
        tone: 'destructive',
      };
    case 'archive':
      return {
        title: `Archive ${sessions(count)}?`,
        detail: null,
        confirmLabel: `Archive ${count}`,
        tone: 'normal',
      };
  }
}
