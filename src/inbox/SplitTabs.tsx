import { memo, type ReactElement } from 'react';
import { inboxListContext } from '../shortcuts/contexts';
import { useShortcutLabel } from '../shortcuts/react';
import { SPLITS, type Split } from './derive';

const SPLIT_LABELS: Readonly<Record<Split, string>> = {
  recent: 'Recent',
  woke: 'Woke',
  all: 'All',
};

export interface SplitTabsProps {
  readonly split: Split;
  readonly counts: Readonly<Record<Split, number>>;
  readonly onSplit: (split: Split) => void;
}

export const SplitTabs = memo(function SplitTabs({
  split,
  counts,
  onSplit,
}: SplitTabsProps): ReactElement {
  const nextLabel = useShortcutLabel(inboxListContext, 'nextSplit');
  return (
    <div className="flex items-center gap-1">
      <div role="tablist" aria-label="Splits" className="flex gap-1">
        {SPLITS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={candidate === split}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSplit(candidate)}
            className="rounded px-2 py-1 text-sm aria-selected:bg-blue-500/15 aria-selected:font-medium"
          >
            {SPLIT_LABELS[candidate]}{' '}
            <span className="text-xs tabular-nums opacity-60">{counts[candidate]}</span>
          </button>
        ))}
      </div>
      {nextLabel && <kbd className="font-mono text-xs opacity-50">{nextLabel}</kbd>}
    </div>
  );
});
