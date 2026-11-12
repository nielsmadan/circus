import type { ReactElement } from 'react';
import { KeepFocusButton } from './KeepFocusButton';

interface EntryProps {
  readonly label: string;
  readonly detail: string | null;
  readonly count: number;
  readonly current: boolean;
  readonly title?: string;
  readonly onClick: () => void;
}

export function Entry({ label, detail, count, current, title, onClick }: EntryProps): ReactElement {
  return (
    <KeepFocusButton
      aria-current={current}
      title={title}
      onClick={onClick}
      className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-sm aria-[current=true]:bg-blue-500/15 aria-[current=true]:font-medium"
    >
      <span className="flex min-w-0 flex-1 items-baseline truncate">
        {detail !== null && (
          <span className="min-w-0 shrink-[1000] truncate opacity-50 [direction:rtl]">
            <bdi>{detail}</bdi>
          </span>
        )}
        <span className="min-w-0 truncate">{label}</span>
      </span>
      <span className="text-xs tabular-nums opacity-60">{count}</span>
    </KeepFocusButton>
  );
}
