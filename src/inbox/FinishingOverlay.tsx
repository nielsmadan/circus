import type { ReactElement } from 'react';
import type { InboxController } from './useInbox';

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function deadlineNote(finishBy: number, unsent: number): string {
  const dropped =
    unsent === 0
      ? ''
      : ` ${unsent} ${unsent === 1 ? 'change' : 'changes'} not sent by then ${unsent === 1 ? 'is' : 'are'} dropped and will be back on the next launch.`;
  return `Circus quits at ${clockTime(finishBy)} even if work remains.${dropped} Changes already being sent finish in the background.`;
}

export function FinishingOverlay({
  controller,
}: {
  readonly controller: InboxController;
}): ReactElement | null {
  const { closing, entries, finishBy } = controller;
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
        {finishBy !== null && (
          <p className="mt-3 text-sm opacity-80">{deadlineNote(finishBy, unsent)}</p>
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
