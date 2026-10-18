import { memo, type ReactElement } from 'react';
import { inboxListContext } from '../shortcuts/contexts';
import { useShortcutLabel } from '../shortcuts/react';
import type { OutboxEntry } from './outbox';

export interface StatusBarProps {
  readonly entries: readonly OutboxEntry[];
  readonly scanning: boolean;
}

export function statusParts(
  entries: readonly OutboxEntry[],
  scanning: boolean,
  undoKey: string,
): string[] {
  const sending = entries.filter((entry) => entry.state === 'sending');
  const harvesting = sending.filter((entry) => entry.decision.action === 'harvest');
  const otherSending = sending.length - harvesting.length;
  const waiting = entries.length - sending.length;
  const labels = harvesting.map((entry) => `“${entry.decision.row.label}”`).join(', ');
  return [
    harvesting.length > 0 ? `Harvesting ${harvesting.length}… ${labels}` : null,
    otherSending > 0 ? `Sending ${otherSending}…` : null,
    waiting > 0 ? `${waiting} waiting (${undoKey} to undo)` : null,
    scanning ? 'Scanning…' : null,
  ].filter((part): part is string => part !== null);
}

export const StatusBar = memo(function StatusBar({
  entries,
  scanning,
}: StatusBarProps): ReactElement {
  const undoKey = useShortcutLabel(inboxListContext, 'undo')?.toLowerCase() ?? 'z';
  const parts = statusParts(entries, scanning, undoKey);
  return (
    <footer
      role="status"
      aria-label="Inbox status"
      className="flex h-7 shrink-0 items-center gap-4 border-t border-neutral-200 px-3 text-xs opacity-80 dark:border-neutral-800"
    >
      {parts.map((part) => (
        <span key={part} className="truncate">
          {part}
        </span>
      ))}
    </footer>
  );
});
