import { memo, type ReactElement } from 'react';
import type { SessionRow } from '../api/types';
import { spanText } from './age';

const HEADING = 'px-2 pt-3 pb-1 text-xs font-semibold tracking-wide uppercase opacity-60';

export interface WakingSoonProps {
  readonly rows: readonly SessionRow[];
  readonly now: string;
}

export const WakingSoon = memo(function WakingSoon({
  rows,
  now,
}: WakingSoonProps): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="waking-soon-heading">
      <h3 id="waking-soon-heading" className={HEADING}>
        Waking soon
      </h3>
      <ul className="flex flex-col gap-px text-sm">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2 px-2 py-1">
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            <span className="text-xs tabular-nums opacity-60">
              {row.snoozed_until === null ? '' : `in ${spanText(now, row.snoozed_until)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
});
