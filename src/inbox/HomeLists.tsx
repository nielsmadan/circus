import { memo, type ReactElement } from 'react';
import type { SessionRow } from '../api/types';
import { spanText } from './age';
import { KeepFocusButton } from './KeepFocusButton';

const HEADING = 'px-2 pt-3 pb-1 text-xs font-semibold tracking-wide uppercase opacity-60';

export interface InFlightProps {
  readonly rows: readonly SessionRow[];
  readonly onResume: (row: SessionRow) => void;
}

export const InFlight = memo(function InFlight({
  rows,
  onResume,
}: InFlightProps): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="in-flight-heading">
      <h3 id="in-flight-heading" className={HEADING}>
        In flight
      </h3>
      <ul className="flex flex-col gap-px">
        {rows.map((row) => (
          <li key={row.id}>
            <KeepFocusButton
              title={`Resume “${row.label}”`}
              onClick={() => onResume(row)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-neutral-500/10"
            >
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              <span className="text-xs opacity-60">{row.agent}</span>
            </KeepFocusButton>
          </li>
        ))}
      </ul>
    </section>
  );
});

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
