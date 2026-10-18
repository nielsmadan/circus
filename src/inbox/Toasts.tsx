import type { ReactElement } from 'react';
import { inboxListContext } from '../shortcuts/contexts';
import { useShortcutLabel } from '../shortcuts/react';
import type { ToastTone } from './messages';
import type { InboxController } from './useInbox';

const TONE_CLASS: Readonly<Record<ToastTone, string>> = {
  info: 'border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900',
  warning: 'border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950',
  error: 'border-red-400 bg-red-50 dark:border-red-700 dark:bg-red-950',
};

export function Toasts({ controller }: { readonly controller: InboxController }): ReactElement {
  const undoLabel = useShortcutLabel(inboxListContext, 'undo');
  const newestUnsent = controller.entries.findLast((entry) => entry.state !== 'sending');
  const undoTicket = newestUnsent?.decision.ticket ?? null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {controller.toasts.map((toast) => (
        <div
          key={toast.id}
          title={toast.detail ?? undefined}
          className={`pointer-events-auto flex items-center gap-3 rounded-md border px-3 py-2 text-sm shadow-md ${TONE_CLASS[toast.tone]}`}
        >
          <span className="flex-1">{toast.text}</span>
          {toast.undo && toast.ticket !== null && toast.ticket === undoTicket && (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => controller.undo()}
              className="flex items-center gap-1 font-medium text-blue-600 dark:text-blue-400"
            >
              Undo
              {undoLabel && <kbd className="font-mono text-xs opacity-70">{undoLabel}</kbd>}
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            aria-label="Dismiss"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => controller.dismissToast(toast.id)}
            className="opacity-50 hover:opacity-100"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
