import { memo, type ReactElement, type ReactNode } from 'react';
import type { ListResponse } from '../api/types';

export interface BannersProps {
  readonly decisionsBlocked: string | null;
  readonly list: ListResponse | null;
  readonly roundupDismissed: boolean;
  readonly onDismissRoundup: () => void;
  readonly loadErrorMessage: string | null;
}

function Banner({
  tone,
  children,
  onDismiss,
}: {
  readonly tone: 'warning' | 'error';
  readonly children: ReactNode;
  readonly onDismiss?: () => void;
}): ReactElement {
  const toneClass =
    tone === 'error'
      ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950'
      : 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'note'}
      className={`flex items-start gap-2 border-b px-3 py-2 text-sm ${toneClass}`}
    >
      <p className="flex-1">{children}</p>
      {onDismiss && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Dismiss"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onDismiss}
          className="opacity-60 hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
}

export function roundupText(roundup: ListResponse['roundup']): string {
  const ran =
    roundup.age_human === null ? 'Roundup has never run' : `Roundup last ran ${roundup.age_human}`;
  return `${ran} — run it with \`rl roundup\`; the Enrich tab will run it later`;
}

export function presenceText(problem: string | null): string {
  const lead =
    "Can't tell which sessions are running — archive, delete and harvest will be refused.";
  return problem ? `${lead} ${problem}` : lead;
}

export const Banners = memo(function Banners(props: BannersProps): ReactElement {
  const { decisionsBlocked, list, roundupDismissed, onDismissRoundup, loadErrorMessage } = props;
  return (
    <div>
      {loadErrorMessage !== null && <Banner tone="error">{loadErrorMessage}</Banner>}
      {decisionsBlocked !== null && decisionsBlocked !== 'Loading…' && (
        <Banner tone="warning">{decisionsBlocked}</Banner>
      )}
      {list?.presence.state === 'unknown' && (
        <Banner tone="warning">{presenceText(list.presence.problem)}</Banner>
      )}
      {list?.roundup.stale === true && !roundupDismissed && (
        <Banner tone="warning" onDismiss={onDismissRoundup}>
          {roundupText(list.roundup)}
        </Banner>
      )}
    </div>
  );
});
