import { useRef, type ReactElement } from 'react';
import { confirmDialogContext } from '../shortcuts/contexts';
import { useShortcutContext } from '@shortcutkit/react';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  readonly title: string;
  readonly detail: string | null;
  readonly confirmLabel: string;
  readonly tone: 'destructive' | 'normal';
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

const CONFIRM_CLASS: Readonly<Record<ConfirmDialogProps['tone'], string>> = {
  destructive: 'bg-red-600 hover:bg-red-700',
  normal: 'bg-blue-600 hover:bg-blue-700',
};

export function ConfirmDialog(props: ConfirmDialogProps): ReactElement {
  const { title, detail, confirmLabel, tone, onConfirm, onClose } = props;
  const cancelRef = useRef<HTMLButtonElement>(null);
  useShortcutContext(confirmDialogContext, () => onClose());
  return (
    <Modal
      role="alertdialog"
      labelledBy="confirm-title"
      panelClassName="w-96"
      initialFocus={cancelRef}
    >
      <h2 id="confirm-title" className="text-sm font-semibold">
        {title}
      </h2>
      {detail !== null && <p className="mt-1 text-sm opacity-70">{detail}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          ref={cancelRef}
          onClick={onClose}
          className="rounded border border-neutral-300 px-3 py-1 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-neutral-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={`rounded px-3 py-1 text-sm text-white focus:ring-2 focus:ring-blue-500 focus:outline-none ${CONFIRM_CLASS[tone]}`}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
