import { memo, type ReactElement, type ReactNode } from 'react';
import type { SessionRow } from '../api/types';
import { inboxListContext, type InboxListAction } from '../shortcuts/contexts';
import { useShortcutLabel, useShortcutRegistry } from '../shortcuts/react';

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const MOMENT_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatted(format: Intl.DateTimeFormat, iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : format.format(ms);
}

function parked(row: SessionRow): string | null {
  if (row.kept_at !== null) return `kept since ${formatted(DAY_FORMAT, row.kept_at)}`;
  if (row.snoozed_until !== null) {
    return `snoozed until ${formatted(MOMENT_FORMAT, row.snoozed_until)}`;
  }
  return null;
}

function fields(row: SessionRow): readonly (readonly [string, string | null])[] {
  return [
    ['Project', row.project_short],
    ['Agent', row.agent],
    ['Status', row.status],
    ['What it is', row.what_it_is],
    ['Last prompt', row.last_prompt],
    ['Branch', row.git_branch],
    ['Session', row.session_id],
    ['File', row.file],
    ['Size', row.size_human],
    ['Messages', String(row.message_count)],
    ['Activity', row.age_human],
    ['Parked', parked(row)],
  ];
}

const ACTIONS: readonly (readonly [InboxListAction, string])[] = [
  ['harvestArchive', 'Harvest & archive'],
  ['archive', 'Archive'],
  ['delete', 'Delete'],
  ['snooze', 'Snooze'],
  ['keep', 'Keep'],
  ['keepGoing', 'Keep going'],
  ['resume', 'Resume'],
];

const ActionButton = memo(function ActionButton({
  action,
  label,
}: {
  readonly action: InboxListAction;
  readonly label: string;
}): ReactElement {
  const registry = useShortcutRegistry();
  const shortcut = useShortcutLabel(inboxListContext, action);
  return (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => registry.dispatch(inboxListContext, action)}
      className="flex items-center gap-1.5 rounded border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-500/10 dark:border-neutral-700"
    >
      {label}
      {shortcut && <kbd className="font-mono text-xs opacity-60">{shortcut}</kbd>}
    </button>
  );
});

export interface ReadingPaneProps {
  readonly row: SessionRow | null;
  readonly conversation: ReactNode;
}

export const ReadingPane = memo(function ReadingPane({
  row,
  conversation,
}: ReadingPaneProps): ReactElement {
  if (row === null) {
    return (
      <section aria-label="Reading pane" className="p-6 text-sm opacity-60">
        No session selected
      </section>
    );
  }
  return (
    <section
      aria-label="Reading pane"
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4"
    >
      <h2 className="text-lg font-semibold break-words">{row.label}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {fields(row).map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="opacity-60">{name}</dt>
            <dd className="min-w-0 break-words">{value === null || value === '' ? '—' : value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map(([action, label]) => (
          <ActionButton key={action} action={action} label={label} />
        ))}
      </div>
      {conversation}
    </section>
  );
});
