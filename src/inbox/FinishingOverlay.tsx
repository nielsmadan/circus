import type { ReactElement } from 'react';
import type { InboxController } from './useInbox';

export function FinishingOverlay({
  controller,
}: {
  readonly controller: InboxController;
}): ReactElement | null {
  const { closing, entries } = controller;
  if (!closing || entries.length === 0) return null;
  const unsent = entries.filter((entry) => entry.state !== 'sending').length;
  const harvesting = entries.filter(
    (entry) => entry.state === 'sending' && entry.decision.action === 'harvest',
  );
  const noun = entries.length === 1 ? 'change' : 'changes';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="finishing-title"
        className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-lg border bg-white p-5 shadow-xl dark:bg-neutral-900"
      >
        <h2 id="finishing-title" className="text-base font-semibold">
          {`Finishing ${entries.length} ${noun}…`}
        </h2>
        {harvesting.length > 0 && (
          <ul className="mt-3 list-disc pl-5 text-sm opacity-80">
            {harvesting.map((entry) => (
              <li key={entry.decision.ticket}>Harvesting “{entry.decision.row.label}”</li>
            ))}
          </ul>
        )}
        {unsent > 0 && (
          <button
            type="button"
            onClick={() => controller.discardUnsent()}
            className="mt-4 rounded border px-3 py-1 text-sm"
          >
            Discard unsent ({unsent})
          </button>
        )}
      </div>
    </div>
  );
}
