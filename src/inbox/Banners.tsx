import { memo, type ReactElement, type ReactNode } from 'react';
import type { ListResponse } from '../api/types';
import { KeepFocusButton } from './KeepFocusButton';
import { PRESENCE_TEXT } from './messages';

export interface BannersProps {
  readonly decisionsBlocked: string | null;
  readonly list: ListResponse | null;
  readonly installingPresence: boolean;
  readonly onInstallPresence: () => void;
  readonly loadError: string | null;
  readonly onRetry: () => void;
}

function Banner({
  tone,
  children,
  detail = null,
  action = null,
}: {
  readonly tone: 'warning' | 'error';
  readonly children: ReactNode;
  readonly detail?: string | null;
  readonly action?: ReactNode;
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
      <div className="flex-1">
        <p>{children}</p>
        {detail !== null && (
          <details className="mt-0.5 text-xs opacity-70">
            <summary className="cursor-default">Details</summary>
            <p className="whitespace-pre-wrap">{detail}</p>
          </details>
        )}
      </div>
      {action}
    </div>
  );
}

const ACTION_CLASS = 'shrink-0 rounded border px-2 py-0.5 text-xs disabled:opacity-50';

export const Banners = memo(function Banners(props: BannersProps): ReactElement {
  const { decisionsBlocked, list, installingPresence, onInstallPresence, loadError, onRetry } =
    props;
  return (
    <div>
      {loadError !== null && (
        <Banner
          tone="error"
          detail={loadError}
          action={
            <KeepFocusButton
              onClick={onRetry}
              className={`${ACTION_CLASS} border-red-400 dark:border-red-700`}
            >
              Retry
            </KeepFocusButton>
          }
        >
          Couldn’t load sessions
        </Banner>
      )}
      {decisionsBlocked !== null && decisionsBlocked !== 'Loading…' && (
        <Banner tone="warning">{decisionsBlocked}</Banner>
      )}
      {list?.presence.state === 'unknown' && (
        <Banner
          tone="warning"
          detail={list.presence.problem}
          action={
            list.presence.code === 'not_installed' && (
              <KeepFocusButton
                disabled={installingPresence}
                onClick={onInstallPresence}
                className={`${ACTION_CLASS} border-amber-400 dark:border-amber-700`}
              >
                {installingPresence ? 'Turning on…' : 'Turn on running-session detection'}
              </KeepFocusButton>
            )
          }
        >
          {PRESENCE_TEXT}
        </Banner>
      )}
    </div>
  );
});
