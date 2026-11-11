import type { ReactElement } from 'react';
import type { CircusError, InstalledStatus } from '../api/types';

export interface UpdateBannerProps {
  readonly status: InstalledStatus;
  readonly updating: boolean;
  readonly disabled: boolean;
  readonly error: CircusError | null;
  readonly onUpdate: () => void;
  readonly onLater: () => void;
  readonly onStopAsking: () => void;
}

export function UpdateBanner({
  status,
  updating,
  disabled,
  error,
  onUpdate,
  onLater,
  onStopAsking,
}: UpdateBannerProps): ReactElement {
  return (
    <div
      role="note"
      aria-label="Update available"
      className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-1.5 text-sm dark:border-blue-900 dark:bg-blue-950"
    >
      <p className="flex-1">
        {error === null
          ? `ringleader ${status.latest} is available (you have ${status.installed}).`
          : error.message}
      </p>
      <button
        type="button"
        disabled={disabled || !status.can_install}
        onClick={onUpdate}
        className="rounded border border-blue-300 px-2 py-0.5 text-xs disabled:opacity-50 dark:border-blue-800"
      >
        {updating ? 'Updating…' : 'Update'}
      </button>
      <button type="button" onClick={onLater} className="text-xs opacity-70 hover:opacity-100">
        Not now
      </button>
      <button type="button" onClick={onStopAsking} className="text-xs opacity-70 hover:opacity-100">
        Don’t ask again
      </button>
    </div>
  );
}
